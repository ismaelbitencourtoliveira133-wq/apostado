/**
 * =============================================================================
 *  EVE BOT — Sistema de Partidas e Apostas para Discord (versão em 1 arquivo)
 * =============================================================================
 *  Este arquivo concentra tudo que normalmente ficaria dividido em
 *  commands/ events/ handlers/ utils/ database/ embeds/ buttons/ da base Eve.
 *  As seções abaixo estão organizadas exatamente na mesma ordem lógica:
 *
 *    1. Configuração e dependências
 *    2. Banco de dados (SQLite) + funções de acesso (models)
 *    3. Utilitários (logger, permissões, formatação)
 *    4. Embeds (aposta e partida)
 *    5. Lógica de fila / matchmaking
 *    6. Comandos slash (/ping, /setup)
 *    7. Handlers de botão (entrar na fila, finalizar/cancelar partida)
 *    8. Eventos do client (ready, interactionCreate)
 *    9. Inicialização do bot (login)
 * =============================================================================
 */

require('dotenv').config();

const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  Collection,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType,
  SlashCommandBuilder,
} = require('discord.js');
const Database = require('better-sqlite3');
const config = require('./config.json');

// =============================================================================
// 1. VALIDAÇÃO DO .env
// =============================================================================
if (!process.env.DISCORD_TOKEN) {
  console.error('[ERRO] DISCORD_TOKEN não definido no arquivo .env. Encerrando.');
  process.exit(1);
}

// =============================================================================
// 2. BANCO DE DADOS (SQLite) — conexão + "models"
// =============================================================================
const db = new Database(path.join(__dirname, 'eve.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS fila (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canal_id TEXT NOT NULL,
    valor_aposta REAL NOT NULL,
    modo TEXT NOT NULL,
    usuario_id TEXT NOT NULL,
    criado_em INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS partidas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canal_partida_id TEXT NOT NULL UNIQUE,
    canal_origem_id TEXT NOT NULL,
    valor_aposta REAL NOT NULL,
    modo TEXT NOT NULL,
    jogador1_id TEXT NOT NULL,
    jogador2_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ongoing',
    criado_em INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mensagens_embed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canal_id TEXT NOT NULL,
    valor_aposta REAL NOT NULL,
    mensagem_id TEXT NOT NULL,
    UNIQUE(canal_id, valor_aposta)
  );
`);

// ---- Model: fila -----------------------------------------------------------
const filaModel = {
  buscarPorUsuarioNoCanal: (canalId, usuarioId) =>
    db.prepare('SELECT * FROM fila WHERE canal_id = ? AND usuario_id = ?').get(canalId, usuarioId),

  adicionar: (canalId, valorAposta, modo, usuarioId) =>
    db
      .prepare(`INSERT INTO fila (canal_id, valor_aposta, modo, usuario_id, criado_em) VALUES (?, ?, ?, ?, ?)`)
      .run(canalId, valorAposta, modo, usuarioId, Date.now()),

  removerPorId: (id) => db.prepare('DELETE FROM fila WHERE id = ?').run(id),

  listarPorCanal: (canalId, valorAposta) =>
    db.prepare('SELECT * FROM fila WHERE canal_id = ? AND valor_aposta = ? ORDER BY criado_em ASC').all(canalId, valorAposta),

  listarPorCanalValorModo: (canalId, valorAposta, modo) =>
    db
      .prepare('SELECT * FROM fila WHERE canal_id = ? AND valor_aposta = ? AND modo = ? ORDER BY criado_em ASC')
      .all(canalId, valorAposta, modo),
};

// ---- Model: partidas ---------------------------------------------------------
const partidaModel = {
  criar: ({ canalPartidaId, canalOrigemId, valorAposta, modo, jogador1Id, jogador2Id }) =>
    db
      .prepare(
        `INSERT INTO partidas (canal_partida_id, canal_origem_id, valor_aposta, modo, jogador1_id, jogador2_id, status, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, 'ongoing', ?)`
      )
      .run(canalPartidaId, canalOrigemId, valorAposta, modo, jogador1Id, jogador2Id, Date.now()),

  buscarPorCanal: (canalPartidaId) => db.prepare('SELECT * FROM partidas WHERE canal_partida_id = ?').get(canalPartidaId),

  atualizarStatus: (canalPartidaId, status) =>
    db.prepare('UPDATE partidas SET status = ? WHERE canal_partida_id = ?').run(status, canalPartidaId),

  listarEmAndamento: () => db.prepare("SELECT * FROM partidas WHERE status = 'ongoing'").all(),
};

// ---- Model: mensagens de embed (para reaproveitar após restart) -------------
const embedMsgModel = {
  buscar: (canalId, valorAposta) =>
    db.prepare('SELECT * FROM mensagens_embed WHERE canal_id = ? AND valor_aposta = ?').get(canalId, valorAposta),

  salvar: (canalId, valorAposta, mensagemId) =>
    db
      .prepare(
        `INSERT INTO mensagens_embed (canal_id, valor_aposta, mensagem_id) VALUES (?, ?, ?)
         ON CONFLICT(canal_id, valor_aposta) DO UPDATE SET mensagem_id = excluded.mensagem_id`
      )
      .run(canalId, valorAposta, mensagemId),
};

// =============================================================================
// 3. UTILITÁRIOS (logger, permissões, formatação)
// =============================================================================
const CORES_CONSOLE = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', success: '\x1b[32m', reset: '\x1b[0m' };
function agora() {
  return new Date().toLocaleString('pt-BR', { hour12: false });
}
const logger = {
  info: (m) => console.log(`${CORES_CONSOLE.info}[INFO]${CORES_CONSOLE.reset} [${agora()}] ${m}`),
  warn: (m) => console.log(`${CORES_CONSOLE.warn}[AVISO]${CORES_CONSOLE.reset} [${agora()}] ${m}`),
  error: (m) => console.log(`${CORES_CONSOLE.error}[ERRO]${CORES_CONSOLE.reset} [${agora()}] ${m}`),
  success: (m) => console.log(`${CORES_CONSOLE.success}[OK]${CORES_CONSOLE.reset} [${agora()}] ${m}`),
  async logToChannel(client, embed) {
    try {
      const canal = await client.channels.fetch(config.canalLogsId).catch(() => null);
      if (!canal) return logger.warn('Canal de logs configurado não foi encontrado.');
      await canal.send({ embeds: [embed] });
    } catch (err) {
      logger.error(`Falha ao enviar log para o canal: ${err.message}`);
    }
  },
};

function ehStaffOuAdmin(member) {
  if (!member?.roles) return false;
  return member.roles.cache.has(config.cargos.staffId) || member.roles.cache.has(config.cargos.administradorId);
}

function formatarValor(valor) {
  return valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// =============================================================================
// 4. EMBEDS
// =============================================================================
function criarBetEmbed(valorAposta, fila) {
  const linhas = fila.length
    ? fila.map((j) => `👤 <@${j.usuario_id}> — ${config.modos[j.modo].label}`).join('\n')
    : '_Nenhum jogador na fila no momento._';

  const embed = new EmbedBuilder()
    .setColor(config.cores.aposta)
    .setTitle(`💰 Aposta R$ ${formatarValor(valorAposta)}`)
    .setDescription(`Escolha o modo abaixo para entrar na fila desta aposta.\n\n**Fila atual:**\n${linhas}`)
    .setFooter({ text: 'Eve Bot • Sistema de Partidas' })
    .setTimestamp();

  const botaoNormal = new ButtonBuilder()
    .setCustomId(`bet:${valorAposta}:normal`)
    .setLabel(`${config.modos.normal.emoji} ${config.modos.normal.label}`)
    .setStyle(ButtonStyle.Success);

  const botaoFull = new ButtonBuilder()
    .setCustomId(`bet:${valorAposta}:full`)
    .setLabel(`${config.modos.full.emoji} ${config.modos.full.label}`)
    .setStyle(ButtonStyle.Primary);

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(botaoNormal, botaoFull)] };
}

function criarMatchEmbed({ valorAposta, modo, jogador1Id, jogador2Id, status = 'ongoing' }) {
  const infoModo = config.modos[modo];
  const dataAtual = new Date();
  const corPorStatus = { ongoing: config.cores.partida, finalizado: config.cores.partida, cancelado: config.cores.cancelado };

  const embed = new EmbedBuilder()
    .setColor(corPorStatus[status] || config.cores.partida)
    .setTitle('🎮 Partida Criada')
    .addFields(
      { name: '💰 Valor da Aposta', value: `R$ ${formatarValor(valorAposta)}`, inline: true },
      { name: '🎯 Modo', value: `${infoModo.emoji} ${infoModo.label}`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: '👥 Jogadores', value: `<@${jogador1Id}>\n<@${jogador2Id}>` },
      { name: '📅 Data e Horário', value: `${dataAtual.toLocaleDateString('pt-BR')} às ${dataAtual.toLocaleTimeString('pt-BR')}` }
    )
    .setFooter({ text: 'Eve Bot • Sistema de Partidas' })
    .setTimestamp();

  const botaoFinalizar = new ButtonBuilder()
    .setCustomId('match:finalizar')
    .setLabel('Finalizar Partida')
    .setEmoji('✅')
    .setStyle(ButtonStyle.Success)
    .setDisabled(status !== 'ongoing');

  const botaoCancelar = new ButtonBuilder()
    .setCustomId('match:cancelar')
    .setLabel('Cancelar Partida')
    .setEmoji('❌')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(status !== 'ongoing');

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(botaoFinalizar, botaoCancelar)] };
}

// =============================================================================
// 5. LÓGICA DE FILA / MATCHMAKING
// =============================================================================
const emProcessamento = new Set(); // trava anti-clique-duplo em memória
const travarUsuario = (id) => (emProcessamento.has(id) ? false : (emProcessamento.add(id), true));
const destravarUsuario = (id) => emProcessamento.delete(id);

function estaEmPartida(usuarioId) {
  return partidaModel.listarEmAndamento().some((p) => p.jogador1_id === usuarioId || p.jogador2_id === usuarioId);
}

/** Reenvia/edita a embed principal de um canal+valor com a fila atualizada. */
async function atualizarEmbedFila(client, canalId, valorAposta) {
  let canal;
  try {
    canal = await client.channels.fetch(canalId);
  } catch (err) {
    logger.error(
      `Não consegui acessar o canal ${canalId} (R$${valorAposta}). Motivo: ${err.message}. ` +
        `Verifique se o ID em config.json está correto e se o bot foi convidado para este servidor ` +
        `com permissão de "Ver Canal" e "Enviar Mensagens" nesse canal.`
    );
    return;
  }
  if (!canal) return logger.warn(`Canal ${canalId} retornou vazio ao tentar atualizar embed.`);
  if (!canal.isTextBased || !canal.isTextBased()) {
    logger.error(`Canal ${canalId} não é um canal de texto (confira se o ID não é de uma categoria/voz).`);
    return;
  }

  const fila = filaModel.listarPorCanal(canalId, valorAposta);
  const conteudo = criarBetEmbed(valorAposta, fila);
  const registro = embedMsgModel.buscar(canalId, valorAposta);

  if (registro) {
    const mensagem = await canal.messages.fetch(registro.mensagem_id).catch(() => null);
    if (mensagem) {
      await mensagem.edit(conteudo).catch((err) => logger.error(`Falha ao editar embed: ${err.message}`));
      return;
    }
  }

  try {
    const novaMensagem = await canal.send(conteudo);
    embedMsgModel.salvar(canalId, valorAposta, novaMensagem.id);
  } catch (err) {
    logger.error(
      `Falha ao ENVIAR a embed no canal ${canalId} (R$${valorAposta}). Motivo: ${err.message}. ` +
        `Provavelmente falta a permissão "Enviar Mensagens" (e "Inserir Links/Embeds") para o bot ` +
        `nesse canal específico.`
    );
  }
}

/** Cria o canal privado de texto para a partida, dentro da categoria configurada. */
async function criarCanalPartida(guild, { valorAposta, modo, jogador1Id, jogador2Id }) {
  try {
    const nomeCanal = `partida-${modo}-${String(valorAposta).replace('.', '-')}`.toLowerCase();
    return await guild.channels.create({
      name: nomeCanal,
      type: ChannelType.GuildText,
      parent: config.categoriaPartidasId || null,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: jogador1Id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: jogador2Id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: config.cargos.staffId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: config.cargos.administradorId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ],
    });
  } catch (err) {
    logger.error(`Falha ao criar canal de partida: ${err.message}`);
    return null;
  }
}

// =============================================================================
// 6. COMANDOS SLASH
// =============================================================================
const comandos = new Collection();

/** Envia/atualiza todas as embeds de aposta em todos os canais configurados. Retorna o total processado. */
async function enviarTodasAsEmbeds(client) {
  const canaisConfigurados = [];
  for (const plataforma of Object.keys(config.canais)) {
    for (const tamanho of Object.keys(config.canais[plataforma])) {
      const canalId = config.canais[plataforma][tamanho];
      if (canalId) canaisConfigurados.push(canalId);
    }
  }

  let total = 0;
  for (const canalId of canaisConfigurados) {
    for (const valorAposta of config.valoresAposta) {
      await atualizarEmbedFila(client, canalId, valorAposta);
      total++;
    }
  }
  return total;
}

comandos.set('ping', {
  data: new SlashCommandBuilder().setName('ping').setDescription('Verifica se o bot está online e sua latência.'),
  async execute(interaction, client) {
    await interaction.reply({ content: `🏓 Pong! Latência da API: \`${Math.round(client.ws.ping)}ms\``, ephemeral: true });
  },
});

// ---- /start — só quem tem o cargo Staff/Administrador (config.cargos) pode usar ----
comandos.set('start', {
  data: new SlashCommandBuilder()
    .setName('start')
    .setDescription('[Staff] Inicia o bot: envia as embeds de aposta em todos os canais configurados.'),
  async execute(interaction, client) {
    if (!ehStaffOuAdmin(interaction.member)) {
      return interaction.reply({
        content: '🚫 Apenas quem tem o cargo Staff ou Administrador pode usar este comando.',
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });
    logger.info(`/start executado por ${interaction.user.tag} (${interaction.user.id}).`);

    const total = await enviarTodasAsEmbeds(client);

    await interaction.editReply(`✅ Bot iniciado! ${total} embed(s) enviada(s)/atualizada(s) com sucesso em todos os canais.`);

    const logEmbed = new EmbedBuilder()
      .setColor(config.cores.log)
      .setTitle('🚀 Bot Iniciado')
      .setDescription(`Comando \`/start\` executado por <@${interaction.user.id}>.\n${total} embed(s) enviada(s)/atualizada(s).`)
      .setTimestamp();
    await logger.logToChannel(client, logEmbed);
  },
});

comandos.set('setup', {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('[Staff] Reenvia/atualiza todas as embeds de aposta em todos os canais configurados.'),
  async execute(interaction, client) {
    if (!ehStaffOuAdmin(interaction.member)) {
      return interaction.reply({ content: '🚫 Você não tem permissão para usar este comando.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const total = await enviarTodasAsEmbeds(client);
    await interaction.editReply(`✅ ${total} embed(s) atualizada(s)/reenviada(s) com sucesso.`);
  },
});

// =============================================================================
// 7. HANDLERS DE BOTÃO
// =============================================================================
const botoes = new Collection();

// ---- bet:<valorAposta>:<modo> — entrar na fila -----------------------------
botoes.set('bet', {
  async execute(interaction, args, client) {
    const [valorApostaStr, modo] = args;
    const valorAposta = parseFloat(valorApostaStr);
    const canalId = interaction.channelId;
    const usuarioId = interaction.user.id;

    if (!travarUsuario(usuarioId)) {
      return interaction.reply({ content: '⏳ Seu clique anterior ainda está sendo processado, aguarde um instante.', ephemeral: true });
    }

    try {
      await interaction.deferUpdate();

      if (estaEmPartida(usuarioId)) {
        return interaction.followUp({ content: '⚠️ Você já está em uma partida em andamento. Finalize-a antes de entrar em outra fila.', ephemeral: true });
      }

      const existente = filaModel.buscarPorUsuarioNoCanal(canalId, usuarioId);
      if (existente) {
        if (existente.valor_aposta === valorAposta && existente.modo === modo) {
          return interaction.followUp({ content: 'ℹ️ Você já está nesta fila.', ephemeral: true });
        }
        filaModel.removerPorId(existente.id);
        await atualizarEmbedFila(client, canalId, existente.valor_aposta);
      }

      filaModel.adicionar(canalId, valorAposta, modo, usuarioId);

      const filaDoModo = filaModel.listarPorCanalValorModo(canalId, valorAposta, modo);
      if (filaDoModo.length >= 2) {
        const [jogador1, jogador2] = filaDoModo; // FIFO
        filaModel.removerPorId(jogador1.id);
        filaModel.removerPorId(jogador2.id);

        const canalPartida = await criarCanalPartida(interaction.guild, {
          valorAposta,
          modo,
          jogador1Id: jogador1.usuario_id,
          jogador2Id: jogador2.usuario_id,
        });

        if (canalPartida) {
          partidaModel.criar({
            canalPartidaId: canalPartida.id,
            canalOrigemId: canalId,
            valorAposta,
            modo,
            jogador1Id: jogador1.usuario_id,
            jogador2Id: jogador2.usuario_id,
          });

          const conteudoPartida = criarMatchEmbed({
            valorAposta,
            modo,
            jogador1Id: jogador1.usuario_id,
            jogador2Id: jogador2.usuario_id,
            status: 'ongoing',
          });

          await canalPartida.send({ content: `<@${jogador1.usuario_id}> <@${jogador2.usuario_id}>`, ...conteudoPartida });

          const logEmbed = new EmbedBuilder()
            .setColor(config.cores.log)
            .setTitle('🆕 Partida Criada')
            .setDescription(
              `Canal de origem: <#${canalId}>\nCanal da partida: <#${canalPartida.id}>\n` +
                `Valor: R$ ${valorAposta.toFixed(2)}\nModo: ${config.modos[modo].label}\n` +
                `Jogadores: <@${jogador1.usuario_id}> e <@${jogador2.usuario_id}>`
            )
            .setTimestamp();
          await logger.logToChannel(client, logEmbed);
        }
      }

      await atualizarEmbedFila(client, canalId, valorAposta);
    } finally {
      destravarUsuario(usuarioId);
    }
  },
});

// ---- match:finalizar / match:cancelar ---------------------------------------
botoes.set('match', {
  async execute(interaction, args, client) {
    const [acao] = args;
    const partida = partidaModel.buscarPorCanal(interaction.channelId);

    if (!partida) return interaction.reply({ content: '⚠️ Esta partida não foi encontrada no banco de dados.', ephemeral: true });
    if (partida.status !== 'ongoing') return interaction.reply({ content: 'ℹ️ Esta partida já foi finalizada/cancelada.', ephemeral: true });
    if (!ehStaffOuAdmin(interaction.member)) {
      return interaction.reply({ content: '🚫 Apenas Staff ou Administradores podem finalizar/cancelar partidas.', ephemeral: true });
    }

    await interaction.deferUpdate();

    const novoStatus = acao === 'finalizar' ? 'finalizado' : 'cancelado';
    partidaModel.atualizarStatus(interaction.channelId, novoStatus);

    const conteudoAtualizado = criarMatchEmbed({
      valorAposta: partida.valor_aposta,
      modo: partida.modo,
      jogador1Id: partida.jogador1_id,
      jogador2Id: partida.jogador2_id,
      status: novoStatus,
    });
    await interaction.editReply(conteudoAtualizado).catch(() => {});

    const textoAviso =
      acao === 'finalizar'
        ? `✅ Partida finalizada por ${interaction.user}. Este canal será apagado em 10 segundos.`
        : `❌ Partida cancelada por ${interaction.user}. Este canal será apagado em 10 segundos.`;
    await interaction.channel.send(textoAviso);

    const logEmbed = new EmbedBuilder()
      .setColor(acao === 'finalizar' ? config.cores.partida : config.cores.cancelado)
      .setTitle(acao === 'finalizar' ? '✅ Partida Finalizada' : '❌ Partida Cancelada')
      .setDescription(
        `Canal: <#${interaction.channelId}>\nResponsável: <@${interaction.user.id}>\n` +
          `Valor: R$ ${partida.valor_aposta.toFixed(2)}\nModo: ${config.modos[partida.modo].label}\n` +
          `Jogadores: <@${partida.jogador1_id}> e <@${partida.jogador2_id}>`
      )
      .setTimestamp();
    await logger.logToChannel(client, logEmbed);

    setTimeout(() => {
      interaction.channel.delete().catch((err) => logger.error(`Falha ao apagar canal de partida: ${err.message}`));
    }, 10_000);
  },
});

// =============================================================================
// 8. EVENTOS DO CLIENT
// =============================================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});
client.commands = comandos;

async function registrarComandosNaAPI() {
  const { DISCORD_TOKEN: token, CLIENT_ID: clientId, GUILD_ID: guildId } = process.env;
  if (!token || !clientId) return logger.warn('CLIENT_ID ausente — pulei o registro de slash commands.');

  const rest = new REST({ version: '10' }).setToken(token);
  const body = comandos.map((c) => c.data.toJSON());

  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
      logger.success(`Slash commands registrados na guild ${guildId}.`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body });
      logger.success('Slash commands registrados globalmente (pode levar até 1h para propagar).');
    }
  } catch (err) {
    logger.error(`Falha ao registrar slash commands: ${err.message}`);
  }
}

client.once('ready', async () => {
  logger.success(`Bot conectado como ${client.user.tag}.`);
  await registrarComandosNaAPI();

  const canaisConfigurados = [];
  for (const plataforma of Object.keys(config.canais)) {
    for (const tamanho of Object.keys(config.canais[plataforma])) {
      const canalId = config.canais[plataforma][tamanho];
      if (canalId) canaisConfigurados.push({ plataforma, tamanho, canalId });
    }
  }

  // ---- Diagnóstico prévio: confere se cada canal configurado é acessível ----
  logger.info('Verificando acesso a cada canal configurado em config.json...');
  for (const { plataforma, tamanho, canalId } of canaisConfigurados) {
    try {
      const canalTeste = await client.channels.fetch(canalId);
      if (!canalTeste) {
        logger.error(`[${plataforma}/${tamanho}] Canal ${canalId} NÃO encontrado (fetch retornou vazio).`);
      } else if (!canalTeste.isTextBased || !canalTeste.isTextBased()) {
        logger.error(`[${plataforma}/${tamanho}] Canal ${canalId} existe mas NÃO é um canal de texto.`);
      } else {
        const permissoesBot = canalTeste.permissionsFor(client.user);
        const podeVer = permissoesBot?.has(PermissionFlagsBits.ViewChannel);
        const podeEnviar = permissoesBot?.has(PermissionFlagsBits.SendMessages);
        if (!podeVer || !podeEnviar) {
          logger.error(
            `[${plataforma}/${tamanho}] Canal ${canalId} encontrado, mas o bot NÃO tem permissão de ` +
              `${!podeVer ? 'Ver Canal ' : ''}${!podeEnviar ? 'Enviar Mensagens' : ''} nele.`
          );
        } else {
          logger.success(`[${plataforma}/${tamanho}] Canal ${canalId} OK (acessível e com permissão).`);
        }
      }
    } catch (err) {
      logger.error(
        `[${plataforma}/${tamanho}] Não foi possível acessar o canal ${canalId}. Motivo: ${err.message}. ` +
          `O ID está correto? O bot foi convidado para este servidor?`
      );
    }
  }

  logger.success('Diagnóstico concluído. As embeds NÃO são enviadas automaticamente.');
  logger.info('Peça para alguém com o cargo Staff/Administrador usar o comando /start no Discord para enviar as embeds.');
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const comando = comandos.get(interaction.commandName);
      if (!comando) return;
      return comando.execute(interaction, client);
    }

    if (interaction.isButton()) {
      const [prefixo, ...args] = interaction.customId.split(':');
      const handler = botoes.get(prefixo);
      if (!handler) return logger.warn(`Nenhum handler encontrado para o botão "${interaction.customId}".`);

      try {
        await handler.execute(interaction, args, client);
      } catch (err) {
        logger.error(`Erro ao executar botão "${interaction.customId}": ${err.stack || err.message}`);
        const payload = { content: '❌ Ocorreu um erro ao processar esta ação.', ephemeral: true };
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
        else await interaction.reply(payload).catch(() => {});
      }
    }
  } catch (err) {
    logger.error(`Erro não tratado em interactionCreate: ${err.stack || err.message}`);
  }
});

process.on('unhandledRejection', (err) => logger.error(`Promise rejeitada não tratada: ${err?.stack || err}`));
process.on('uncaughtException', (err) => logger.error(`Exceção não tratada: ${err?.stack || err}`));

// =============================================================================
// 9. LOGIN
// =============================================================================
client.login(process.env.DISCORD_TOKEN);
