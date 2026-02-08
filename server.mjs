import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { Telegraf, Markup } from "telegraf";
import QRCode from "qrcode";
import dotenv from "dotenv";
import fs from "fs";
import OpenAI from "openai";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
const PORT = Number(process.env.PORT || 8788);

// Garantir diretório de uploads
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
app.use("/uploads", express.static(UPLOADS_DIR));

// -- Configurações e Env --
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const WUZAPI_BASE_URL = process.env.WUZAPI_BASE_URL || "http://localhost:8080";
const WUZAPI_ADMIN_TOKEN = process.env.WUZAPI_ADMIN_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `http://localhost:${PORT}/webhook`;

// -- Supabase Setup --
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -- Persistence Layer (Supabase) --
const activePolls = new Map();

async function getSession(chatId) {
    const id = String(chatId);

    // Tenta buscar no banco
    const { data, error } = await supabase
        .from('bot_sessions')
        .select('data')
        .eq('chat_id', id)
        .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = NOT FOUND
        log("Erro ao buscar sessão: " + error.message);
    }

    if (data) return data.data;

    // Se não existir, cria padrão
    const newSession = {
        stage: "START",
        isVip: false,
        subscriptionExpiry: null,
        whatsapp: { instances: [], maxInstances: 1 },
        reports: {}
    };

    await saveSession(id, newSession);
    return newSession;
}

async function saveSession(chatId, sessionData) {
    const id = String(chatId);
    const { error } = await supabase
        .from('bot_sessions')
        .upsert({
            chat_id: id,
            data: sessionData,
            updated_at: new Date().toISOString()
        });

    if (error) log("Erro ao salvar sessão: " + error.message);
}

// Helper para salvar sessão atual rapidamente
async function syncSession(ctx, session) {
    await saveSession(ctx.chat.id, session);
}

async function checkOwnership(ctx, instId) {
    const session = await getSession(ctx.chat.id);
    const inst = (session.whatsapp?.instances || []).find(i => i.id === instId);
    if (!inst) {
        log(`[SECURITY] Tentativa de acesso não autorizado: User=${ctx.chat.id}, Inst=${instId}`);
        try {
            if (ctx.updateType === "callback_query") {
                await ctx.answerCbQuery("🚫 Acesso Negado!", { show_alert: true });
            } else {
                await ctx.reply("🚫 *Acesso Negado*\n\nEssa instância não pertence à sua conta.", { parse_mode: "Markdown" });
            }
        } catch (e) { }
        return null;
    }
    return inst;
}

async function getSystemConfig() {
    const { data } = await supabase
        .from('bot_sessions')
        .select('data')
        .eq('chat_id', 'SYSTEM_CONFIG')
        .single();

    if (data) return data.data;

    const defaultConfig = {
        planPrice: 49.90,
        referralDays: 7,
        adminChatId: null, // ID do dono
        limits: {
            vip: { instances: 5 }
        }
    };
    await saveSession('SYSTEM_CONFIG', defaultConfig);
    return defaultConfig;
}

async function saveSystemConfig(config) {
    await saveSession('SYSTEM_CONFIG', config);
}

function isAdmin(chatId, config) {
    if (!config.adminChatId) return true; // Primeira vez libera pra cadastrar
    return String(config.adminChatId) === String(chatId);
}

const SERVER_VERSION = "V1.1.46-UI";

async function safeEdit(ctx, text, extra = {}) {
    const session = await getSession(ctx.chat.id);

    // Função para limpar menu anterior se existir
    const killOld = async () => {
        if (session.last_menu_id) {
            try { await ctx.telegram.deleteMessage(ctx.chat.id, session.last_menu_id); } catch (e) { }
            session.last_menu_id = null;
        }
    };

    if (ctx.callbackQuery) {
        try {
            await ctx.editMessageText(text, { parse_mode: "Markdown", ...extra });
            // Se editou a mensagem atual, esse ID continua sendo o nosso last_menu_id ativo
            session.last_menu_id = ctx.callbackQuery.message.message_id;
            await syncSession(ctx, session);
        } catch (e) {
            // Se falhou ao editar (ex: mensagem expirou), apaga e manda nova
            await killOld();
            const sent = await ctx.reply(text, { parse_mode: "Markdown", ...extra });
            session.last_menu_id = sent.message_id;
            await syncSession(ctx, session);
        }
    } else {
        // Se é um comando (/start), mata o menu antigo e manda novo
        await killOld();
        const sent = await ctx.reply(text, { parse_mode: "Markdown", ...extra });
        session.last_menu_id = sent.message_id;
        await syncSession(ctx, session);
    }
}

function log(msg) {
    const logMsg = `[BOT LOG] [V${SERVER_VERSION}] ${new Date().toLocaleTimeString()} - ${msg}`;
    console.log(logMsg);
    try { fs.appendFileSync("bot.log", logMsg + "\n"); } catch (e) { }
}

const aiQueues = new Map(); // Debouncing

async function safeDelete(ctx) {
    try {
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
            // Efeito de Desintegração Simulado (Particle Dissolve)
            const frames = ["▓▓▓▓▓▓▓▓▓", "▒▒▒▒▒▒▒▒▒", "░░░░░░░░░", "........."];
            for (const frame of frames) {
                try {
                    await ctx.editMessageText(frame).catch(() => { });
                    await new Promise(r => setTimeout(r, 100)); // Delay curto para fluidez
                } catch (e) { break; }
            }
            await ctx.deleteMessage().catch(() => { });
        } else if (ctx.message) {
            await ctx.deleteMessage().catch(() => { });
        }
    } catch (e) { }
}

async function checkVip(chatId) {
    const session = await getSession(chatId);
    if (!session.isVip) return false;
    if (!session.subscriptionExpiry) return false;
    const expiry = new Date(session.subscriptionExpiry);
    return expiry > new Date();
}

// -- WUZAPI Handler --
async function callWuzapi(endpoint, method = "GET", body = null, userToken = null) {
    const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json"
    };

    // WUZAPI uses 'token' header for standard endpoints and 'Authorization' for admin
    if (userToken) {
        headers["token"] = userToken;
    } else {
        headers["Authorization"] = WUZAPI_ADMIN_TOKEN;
    }

    try {
        const options = { method, headers };
        if (body) options.body = JSON.stringify(body);

        const url = `${WUZAPI_BASE_URL}${endpoint}`;
        const resp = await fetch(url, options);
        let data = { success: false };
        try {
            data = await resp.json();
        } catch (je) {
            const text = await resp.text();
            log(`[WUZAPI ERR] No JSON from ${endpoint}: ${text.substring(0, 50)}`);
            return { error: true, text, success: false };
        }

        if (data.code === 401 || data.message === "unauthorized") {
            log(`[WUZAPI AUTH ERR] ${endpoint} | Token: ${userToken ? "User" : "Admin"}`);
        }

        if (data.code >= 400 || data.success === false) {
            log(`[WUZAPI FAIL] ${method} ${endpoint} (${resp.status}): ${JSON.stringify(data).substring(0, 200)}`);
        } else {
            // log(`[WUZAPI OK] ${method} ${endpoint} (${resp.status})`);
        }
        return data;
    } catch (e) {
        log(`[WUZAPI FATAL] ${method} ${endpoint}: ${e.message}`);
        return { error: true, message: e.message, success: false };
    }
}

async function ensureWebhookSet(id) {
    try {
        const res = await callWuzapi("/webhook", "GET", null, id);
        const currentWeb = res.data?.webhook || "";
        const currentEvents = res.data?.events || "";

        // Se o webhook for diferente do nosso, registramos mas continuamos para atualizar (especialmente útil na migração local -> VPS)
        if (currentWeb && currentWeb !== WEBHOOK_URL) {
            log(`[WEBHOOK UPDATE] ${id} tinha: ${currentWeb}. Atualizando para: ${WEBHOOK_URL}`);
        }

        // Se já for o nosso E os eventos estiverem OK, não precisa refazer
        if (currentWeb === WEBHOOK_URL && (currentEvents === "All" || (Array.isArray(currentEvents) && currentEvents.includes("All")))) {
            return;
        }

        log(`[WEBHOOK SYNC] Sincronizando webhook e eventos para ${id}...`);
        // Obter o UUID interno via status de sessão
        const statusRes = await callWuzapi("/session/status", "GET", null, id);
        const uuid = statusRes?.data?.id;

        const robustPayload = {
            webhook: WEBHOOK_URL,
            WebhookURL: WEBHOOK_URL,
            events: ["All"],
            subscribe: ["All"],
            Active: true,
            active: true
        };
        // 1. Salvar no endpoint de usuário (Array de eventos)
        await callWuzapi("/webhook", "PUT", robustPayload, id);

        // 2. Salvar via Admin se tivermos o UUID (String de eventos)
        if (uuid) {
            const adminPayload = {
                webhook: WEBHOOK_URL,
                events: "All",
                subscribe: "All",
                Active: true
            };
            await callWuzapi(`/admin/users/${uuid}`, "PUT", adminPayload);
        }

        log(`[WEBHOOK AUTO-SET] Webhook configurado para ${id} (UUID: ${uuid || "N/A"})`);
    } catch (e) {
        log(`[ERR AUTO-SET WEBHOOK] ${id}: ${e.message}`);
    }
}

// (Moved renderWebhookMenu later in the file for better organization)

// -- SyncPay Integration --
const SYNCPAY_CLIENT_ID = "c2687695-57c9-4f3e-8d59-36fbdabb0a44";
const SYNCPAY_CLIENT_SECRET = "42f39fd6-00bc-4f11-96d7-e98e4db9b93a";
const SYNC_BASE_URL = "https://api.syncpayments.com.br";

async function getSyncPayToken() {
    try {
        const res = await fetch(`${SYNC_BASE_URL}/api/partner/v1/auth-token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: SYNCPAY_CLIENT_ID, client_secret: SYNCPAY_CLIENT_SECRET })
        });
        const json = await res.json();
        return json.access_token;
    } catch (e) { log(`[ERR SYNC AUTH] ${e.message}`); throw e; }
}

async function createSyncPayPix(chatId, amount, name = "Usuario Venux") {
    try {
        const token = await getSyncPayToken();
        const res = await fetch(`${SYNC_BASE_URL}/api/partner/v1/cash-in`, {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                amount: amount,
                description: `Assinatura Venux WhatsApp Pro - ID ${chatId}`,
                webhook_url: WEBHOOK_URL,
                external_id: String(chatId),
                client: { name, cpf: "00000000000", email: "cliente@vendas.com", phone: "00000000000" }
            })
        });
        return await res.json();
    } catch (e) { log(`[ERR PIX] ${e.message}`); return { error: true }; }
}

// -- Telegraf Bot Setup --
const bot = new Telegraf(TELEGRAM_TOKEN);

function safeAnswer(ctx) {
    try { ctx.answerCbQuery().catch(() => { }); } catch (e) { }
}

// --- Admin Panel Handlers ---
async function renderAdminPanel(ctx) {
    const config = await getSystemConfig();
    const { count } = await supabase.from('bot_sessions').select('*', { count: 'exact', head: true });

    const text = `👑 *Painel Admin SaaS*\n\n` +
        `👥 *Usuários:* ${count || 0}\n` +
        `💰 *Preço Atual:* R$ ${config.planPrice.toFixed(2)}\n` +
        `💎 *Limite Instâncias VIP:* ${config.limits.vip.instances}\n` +
        `🤝 *Corretores:* Liberados (Ilimitados)\n`;

    const buttons = [
        [Markup.button.callback("📢 Broadcast (Msg em Massa)", "admin_broadcast")],
        [Markup.button.callback("💰 Alterar Preço", "admin_price")],
        [Markup.button.callback("💎 Ajustar Limite Instâncias", "admin_limit_vip")],
        [Markup.button.callback("👤 Ativar VIP Manual", "admin_vip_manual")],
        [Markup.button.callback("🔙 Voltar", "start")]
    ];

    await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
}

bot.command("admin", async (ctx) => {
    const config = await getSystemConfig();
    const chatId = ctx.chat.id;

    if (!config.adminChatId) {
        config.adminChatId = chatId;
        await saveSystemConfig(config);
        return ctx.reply("👑 *Admin Configurado!* Você agora é o dono do bot.\nUse /admin novamente.", { parse_mode: "Markdown" });
    }

    if (!isAdmin(chatId, config)) return ctx.reply("⛔ Acesso negado.");
    await renderAdminPanel(ctx);
});

bot.action("cmd_admin_panel", async (ctx) => {
    safeAnswer(ctx);
    const config = await getSystemConfig();
    if (!isAdmin(ctx.chat.id, config)) return ctx.reply("⛔ Acesso negado.");
    await renderAdminPanel(ctx);
});

bot.command("meu_id", (ctx) => {
    ctx.reply(`🆔 Seu ID: \`${ctx.chat.id}\``, { parse_mode: "Markdown" });
});

bot.action("admin_exit", (ctx) => {
    ctx.deleteMessage();
});

// --- Admin Button Handlers ---
bot.action("admin_broadcast", async (ctx) => {
    safeAnswer(ctx);
    const session = await getSession(ctx.chat.id);
    session.stage = "ADMIN_WAIT_BROADCAST";
    await syncSession(ctx, session);
    ctx.reply("📢 *Modo Broadcast*\n\nDigite a mensagem que deseja enviar para TODOS os usuários:", { parse_mode: "Markdown" });
});

bot.action("admin_price", async (ctx) => {
    safeAnswer(ctx);
    const session = await getSession(ctx.chat.id);
    session.stage = "ADMIN_WAIT_PRICE";
    await syncSession(ctx, session);
    ctx.reply("💰 *Alterar Preço*\n\nDigite o novo valor mensal (ex: 59.90):", { parse_mode: "Markdown" });
});

bot.action("admin_limit_free", async (ctx) => {
    safeAnswer(ctx);
    const session = await getSession(ctx.chat.id);
    session.stage = "ADMIN_WAIT_LIMIT_FREE";
    await syncSession(ctx, session);
    ctx.reply("⚙️ *Limites FREE*\n\nDigite no formato: `INSTANCIAS,CORRETORES` (ex: 1,1):", { parse_mode: "Markdown" });
});

bot.action("admin_limit_vip", async (ctx) => {
    safeAnswer(ctx);
    const session = await getSession(ctx.chat.id);
    session.stage = "ADMIN_WAIT_LIMIT_VIP";
    await syncSession(ctx, session);
    ctx.reply("💎 *Limite de Instâncias VIP*\n\nDigite apenas o número máximo de instâncias que um usuário PRO pode ter (ex: 5):", { parse_mode: "Markdown" });
});

bot.action("admin_vip_manual", async (ctx) => {
    safeAnswer(ctx);
    const session = await getSession(ctx.chat.id);
    session.stage = "ADMIN_WAIT_VIP_MANUAL";
    await syncSession(ctx, session);
    ctx.reply("👑 *Gerenciar VIP*\n\nDigite o ID do usuário (Telegram ChatID) para ativar/desativar VIP:", { parse_mode: "Markdown" });
});

bot.start(async (ctx) => {
    const isVip = await checkVip(ctx.chat.id);
    const config = await getSystemConfig();
    const userFirstName = ctx.from.first_name || "Parceiro";

    const welcomeMsg = `👋 *Olá, ${userFirstName}! Bem-vindo ao Venux SaaS* 🚀\n\n` +
        `O sistema definitivo para automação de WhatsApp com IA e Rodízio de Leads.\n\n` +
        `👇 *Escolha uma opção no menu abaixo:*`;

    if (!isVip && !isAdmin(ctx.chat.id, config)) {
        const promoMsg = `👋 *Olá, ${userFirstName}! Bem-vindo ao Venux SaaS* 🚀\n\n` +
            `Para começar a automatizar seu WhatsApp com IA, Disparos e Rodízio de Leads, você precisa de uma assinatura ativa.\n\n` +
            `💎 *Plano Mensal:* R$ ${config.planPrice.toFixed(2)}\n\n` +
            `✅ Acesso ilimitado às ferramentas\n` +
            `✅ Suporte prioritário\n\n` +
            `👇 *Assine agora via Pix para liberar seu acesso:*`;
        return await safeEdit(ctx, promoMsg, Markup.inlineKeyboard([
            [Markup.button.callback("💎 Assinar Agora (Pix)", "gen_pix_mensal")],
            [Markup.button.callback("👤 Suporte / Ajuda", "cmd_suporte")]
        ]));
    }

    const buttons = [
        [Markup.button.callback("🚀 Minhas Instâncias", "cmd_instancias_menu")],
        [Markup.button.callback("📢 Disparo em Massa", "cmd_shortcuts_disparos"), Markup.button.callback("👥 Rodízio de Leads", "cmd_shortcuts_rodizio")],
        [Markup.button.callback("🔔 Follow-ups / Agenda", "cmd_shortcuts_followups")],
        [Markup.button.callback("💎 Seu Plano (Ativo)", "cmd_planos_menu"), Markup.button.callback("👤 Suporte / Ajuda", "cmd_suporte")]
    ];

    if (isAdmin(ctx.chat.id, config)) {
        buttons.push([Markup.button.callback("👑 Painel Admin", "cmd_admin_panel")]);
    }

    await safeEdit(ctx, welcomeMsg, Markup.inlineKeyboard(buttons));
});

// --- Menu Handlers ---
bot.action("cmd_instancias_menu", async (ctx) => {
    safeAnswer(ctx);
    await showInstances(ctx);
});

// Atalhos Globais (SaaS Dashboard)
bot.action("cmd_shortcuts_disparos", async (ctx) => {
    safeAnswer(ctx);
    const session = await getSession(ctx.chat.id);
    if (session.whatsapp.instances.length === 0) return ctx.reply("❌ Você não tem nenhuma instância conectada.");

    const buttons = session.whatsapp.instances.map(inst => [Markup.button.callback(`📢 Campanhas: ${inst.name}`, `wa_mass_init_${inst.id}`)]);
    buttons.push([Markup.button.callback("🔙 Voltar", "start")]);
    ctx.editMessageText("📢 *Escolha uma instância para gerenciar Disparos:*", { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.command("stats", async (ctx) => {
    try {
        const session = await getSession(ctx.chat.id);
        const instIds = session.whatsapp.instances.map(i => i.id);

        if (instIds.length === 0) return ctx.reply("❌ Você ainda não possui instâncias configuradas.");

        // 1. Leads Qualificados Totais
        const { data: leads, error } = await supabase
            .from("ai_leads_tracking")
            .select("*")
            .in("instance_id", instIds)
            .eq("status", "HUMAN_ACTIVE");

        if (error) throw error;

        // 2. Leads de Hoje
        const today = new Date().toISOString().split('T')[0];
        const leadsToday = leads.filter(l => l.last_interaction.startsWith(today));

        // 3. Stats por Instância
        let instStats = "";
        for (const inst of session.whatsapp.instances) {
            const count = leads.filter(l => l.instance_id === inst.id).length;
            instStats += `- *${inst.name}:* ${count} leads qualificados\n`;
        }

        const msg = `📊 *Dashboard de Leads (Analytics)*\n\n` +
            `🔥 *Leads Qualificados (Total):* ${leads.length}\n` +
            `📅 *Leads de Hoje:* ${leadsToday.length}\n\n` +
            `📱 *Performance por Instância:*\n${instStats || '_Sem dados_'}\n\n` +
            `💡 *Dica:* Seus leads qualificados são aqueles que foram pausados para atendimento humano ou entregues via rodízio.`;

        ctx.reply(msg, { parse_mode: "Markdown" });
    } catch (e) {
        log(`[STATS ERR] ${e.message}`);
        ctx.reply("❌ Erro ao buscar estatísticas. Tente novamente mais tarde.");
    }
});

bot.action("cmd_shortcuts_rodizio", async (ctx) => {
    safeAnswer(ctx);
    const session = await getSession(ctx.chat.id);
    if (session.whatsapp.instances.length === 0) return ctx.reply("❌ Você não tem nenhuma instância conectada.");

    const buttons = session.whatsapp.instances.map(inst => [Markup.button.callback(`👥 Rodízio: ${inst.name}`, `wa_brokers_menu_${inst.id}`)]);
    buttons.push([Markup.button.callback("🔙 Voltar", "start")]);
    ctx.editMessageText("👥 *Escolha uma instância para gerenciar Rodízio de Corretores:*", { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action("cmd_shortcuts_followups", async (ctx) => {
    safeAnswer(ctx);
    const session = await getSession(ctx.chat.id);
    if (session.whatsapp.instances.length === 0) return ctx.reply("❌ Você não tem nenhuma instância conectada.");

    const buttons = session.whatsapp.instances.map(inst => [Markup.button.callback(`🔔 Follow-ups: ${inst.name}`, `wa_ai_followup_menu_${inst.id}`)]);
    buttons.push([Markup.button.callback("🔙 Voltar", "start")]);
    ctx.editMessageText("🔔 *Escolha uma instância para gerenciar Agendamentos:*", { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action("start", async (ctx) => {
    safeAnswer(ctx);
    await ctx.deleteMessage().catch(() => { });
    // Simula comando /start
    const isVip = await checkVip(ctx.chat.id);
    const config = await getSystemConfig();
    const userFirstName = ctx.from.first_name || "Parceiro";
    const welcomeMsg = `👋 *Olá, ${userFirstName}! Bem-vindo ao Venux SaaS* 🚀\n\n` +
        `O sistema definitivo para automação de WhatsApp com IA e Rodízio de Leads.\n\n` +
        `👇 *Escolha uma opção no menu abaixo:*`;
    const buttons = [
        [Markup.button.callback("🚀 Minhas Instâncias", "cmd_instancias_menu")],
        [Markup.button.callback("📢 Disparo em Massa", "cmd_shortcuts_disparos"), Markup.button.callback("👥 Rodízio de Leads", "cmd_shortcuts_rodizio")],
        [Markup.button.callback("🔔 Follow-ups / Agenda", "cmd_shortcuts_followups")],
        [Markup.button.callback(isVip ? "💎 Área VIP (Ativa)" : "💎 Assinar Premium", "cmd_planos_menu"), Markup.button.callback("👤 Suporte / Ajuda", "cmd_suporte")]
    ];
    if (isAdmin(ctx.chat.id, config)) buttons.push([Markup.button.callback("👑 Painel Admin", "cmd_admin_panel")]);

    await safeEdit(ctx, welcomeMsg, Markup.inlineKeyboard(buttons));
});

bot.action("cmd_planos_menu", async (ctx) => {
    safeAnswer(ctx);
    const isVip = await checkVip(ctx.chat.id);
    const config = await getSystemConfig();
    const limits = config.limits.vip;

    const text = `💎 *Informações do Plano*\n\n` +
        `📊 *Seu Status:* ${isVip ? "✅ ASSINATURA ATIVA" : "❌ AGUARDANDO PAGAMENTO"}\n` +
        `💰 *Valor:* R$ ${config.planPrice.toFixed(2)}/mês\n\n` +
        `🛠️ *Limites do Plano:*\n` +
        `📱 Instâncias: ${limits.instances}\n` +
        `👤 Corretores: ${limits.brokers}\n`;

    const buttons = [];
    if (!isVip) buttons.push([Markup.button.callback("💎 Assinar Agora (Pix)", "gen_pix_mensal")]);
    buttons.push([Markup.button.callback("🔙 Voltar", "start")]);

    ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action("cmd_suporte", (ctx) => {
    safeAnswer(ctx);
    ctx.editMessageText(`👤 *Suporte & Ajuda*\n\nPrecisa de ajuda? Entre em contato com o suporte oficial:\n\n👉 @SeuUsuarioDeSuporte`, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "start")]])
    });
});

bot.action("cmd_start", (ctx) => {
    safeAnswer(ctx);
    ctx.deleteMessage(); // Limpa e manda novo start
    // Gambiarra pra chamar o start de novo, melhor é extrair função
    // Mas como commands são middleware...
    return ctx.reply("Use /start para ver o menu principal.");
});

bot.command("instancias", async (ctx) => {
    return showInstances(ctx);
});

bot.command("conectar", async (ctx) => {
    return startConnection(ctx);
});

bot.command("vip", async (ctx) => {
    return showVipStatus(ctx);
});

bot.command("diag_users", async (ctx) => {
    // Apenas para diagnóstico seu
    const res = await callWuzapi("/admin/users", "GET");
    ctx.reply(`👥 *Usuários WUZAPI:*\n\n\`${JSON.stringify(res, null, 2).substring(0, 3000)}\``, { parse_mode: "Markdown" });
});

bot.command("disparos", async (ctx) => {
    const session = await getSession(ctx.chat.id);
    if (session.whatsapp.instances.length === 0) return ctx.reply("❌ Você não tem nenhuma instância conectada.");
    const buttons = session.whatsapp.instances.map(inst => [Markup.button.callback(`📢 Campanhas: ${inst.name}`, `wa_mass_init_${inst.id}`)]);
    buttons.push([Markup.button.callback("🔙 Voltar", "start")]);
    await safeEdit(ctx, "📢 *Módulo de Disparos em Massa*\n\nEscolha uma instância:", Markup.inlineKeyboard(buttons));
});

bot.command("rodizio", async (ctx) => {
    const session = await getSession(ctx.chat.id);
    if (session.whatsapp.instances.length === 0) return ctx.reply("❌ Você não tem nenhuma instância conectada.");
    const buttons = session.whatsapp.instances.map(inst => [Markup.button.callback(`👥 Rodízio: ${inst.name}`, `wa_brokers_menu_${inst.id}`)]);
    buttons.push([Markup.button.callback("🔙 Voltar", "start")]);
    ctx.reply("👥 *Módulo de Rodízio de Leads*\n\nEscolha uma instância:", { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.command("agenda", async (ctx) => {
    const session = await getSession(ctx.chat.id);
    if (session.whatsapp.instances.length === 0) return ctx.reply("❌ Você não tem nenhuma instância conectada.");
    const buttons = session.whatsapp.instances.map(inst => [Markup.button.callback(`🔔 Follow-ups: ${inst.name}`, `wa_ai_followup_menu_${inst.id}`)]);
    buttons.push([Markup.button.callback("🔙 Voltar", "start")]);
    ctx.reply("🔔 *Módulo de Follow-ups e Agendamentos*\n\nEscolha uma instância:", { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

async function showInstances(ctx) {
    const session = await getSession(ctx.chat.id);
    if (session.whatsapp.instances.length === 0) return ctx.reply("📱 Nenhuma instância encontrada.");

    let msg = "📱 *Suas Instâncias:*\n\n";
    const buttons = [];
    for (const inst of session.whatsapp.instances) {
        // WUZAPI: status is via /session/status with user token
        const stats = await callWuzapi(`/session/status`, "GET", null, inst.id);
        log(`[STATUS CHECK] Instance ${inst.id}: ${JSON.stringify(stats)}`);

        let isOnline = false;
        if (stats.success && stats.data) {
            const d = stats.data;
            // Critério Rígido: On apenas se estiver LoggedIn no WhatsApp
            const isFullyLoggedIn = (d.LoggedIn === true || d.loggedIn === true || d.status === "LoggedIn");
            if (isFullyLoggedIn) {
                isOnline = true;
            }
        }

        const status = isOnline ? "✅ On" : "❌ Off";
        msg += `🔹 **${inst.name}**\n🆔 \`${inst.id}\`\n📡 Status: ${status}\n\n`;
        buttons.push([Markup.button.callback(`⚙️ Gerenciar ${inst.name}`, `manage_${inst.id}`)]);
    }
    buttons.push([Markup.button.callback("🔙 Voltar", "start")]);
    const extra = { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) };

    if (ctx.callbackQuery) {
        try { await ctx.editMessageText(msg, extra); }
        catch (e) { await ctx.reply(msg, extra); }
    } else {
        await ctx.reply(msg, extra);
    }
}

async function startConnection(ctx) {
    const session = await getSession(ctx.chat.id);
    const isVip = await checkVip(ctx.chat.id);
    const config = await getSystemConfig();
    const isAdminUser = isAdmin(ctx.chat.id, config);

    if (!isVip && !isAdminUser) {
        return ctx.reply("❌ Você precisa de uma assinatura VIP ativa para conectar instâncias.", {
            ...Markup.inlineKeyboard([[Markup.button.callback("💎 Gerar Pix", "gen_pix_mensal")]])
        });
    }

    if (!isAdminUser && session.whatsapp.instances.length >= config.limits.vip.instances) {
        return ctx.reply(`❌ Limite de ${config.limits.vip.instances} instâncias atingido.`);
    }
    ctx.reply("🔗 *Nova Conexão*\n\nDigite um **Nome** para identificar esta instância:");
    session.stage = "WA_WAITING_NAME";
    await syncSession(ctx, session);
}

async function showVipStatus(ctx) {
    const session = await getSession(ctx.chat.id);
    const isVip = await checkVip(ctx.chat.id);
    const config = await getSystemConfig();
    if (isVip) {
        const expiry = new Date(session.subscriptionExpiry).toLocaleDateString("pt-BR");
        return ctx.reply(`✅ Você é VIP! Validade: ${expiry}`);
    }
    return ctx.reply(`💳 Assine o plano mensal (R$ ${config.planPrice.toFixed(2).replace('.', ',')}) e libere até 5 números!`, Markup.inlineKeyboard([
        [Markup.button.callback("💎 Gerar Pix agora", "gen_pix_mensal")]
    ]));
}

bot.action("cmd_conectar", async (ctx) => {
    safeAnswer(ctx);
    return startConnection(ctx);
});

bot.action("cmd_instancias", async (ctx) => {
    safeAnswer(ctx);
    return showInstances(ctx);
});

async function renderManageMenu(ctx, id) {
    // Verificar status em tempo real para decidir o que exibir
    const stats = await callWuzapi(`/session/status`, "GET", null, id);
    let isOnline = false;
    let phone = "";
    if (stats.success && stats.data) {
        const d = stats.data;
        const isFullyLoggedIn = (d.LoggedIn === true || d.loggedIn === true || d.status === "LoggedIn");
        if (isFullyLoggedIn) {
            isOnline = true;
            if (d.jid) {
                phone = d.jid.split(":")[0].split("@")[0];
            }
        }
    }

    const session = await getSession(ctx.chat.id);
    const inst = session.whatsapp.instances.find(i => i.id === id);

    const buttons = [];
    if (!isOnline) {
        buttons.push([Markup.button.callback("📷 Gerar QR Code", `wa_qr_${id}`)]);
        buttons.push([Markup.button.callback("🔢 Código (8 dígitos)", `wa_pair_${id}`)]);
    } else {
        buttons.push([Markup.button.callback("🚀 Disparo em Massa", `wa_mass_init_${id}`)]);
    }

    buttons.push([Markup.button.callback("🤖 Configurar IA SDR", `wa_ai_menu_${id}`)]);

    // Mostra corretores apenas se for nicho imobiliária
    if (inst && inst.niche === 'real_estate') {
        buttons.push([Markup.button.callback("👥 Gerenciar Corretores", `wa_brokers_menu_${id}`)]);
    }

    buttons.push([Markup.button.callback("🚪 Logout", `wa_logout_${id}`), Markup.button.callback("🗑️ Deletar", `wa_del_${id}`)]);
    buttons.push([Markup.button.callback("🔙 Voltar", "cmd_instancias")]);

    let title = isOnline ? `✅ *Painel da Instância: ${id}*\n📱 *Número:* \`${phone}\`` : `🛠️ *Painel da Instância: ${id}*`;

    await safeEdit(ctx, title, Markup.inlineKeyboard(buttons));
}

bot.action(/^manage_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    await renderManageMenu(ctx, id);
});

// Handler para tela de integração API
bot.action(/^wa_api_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;

    const message = `🔗 *Dados de Integração (API / n8n)*\n\n` +
        `Utilize os dados abaixo para conectar sua instância em ferramentas externas como o n8n:\n\n` +
        `📍 *Base URL:* \`${WUZAPI_BASE_URL}\`\n` +
        `🔑 *Token (Instance ID):* \`${id}\`\n\n` +
        `⚠️ *Segurança:* Este token permite apenas o controle desta instância específica. Nunca compartilhe seu token de administrador global.\n\n` +
        `💡 *Dica no n8n:* Use o nó *HTTP Request* e adicione um Header chamado \`token\` com o valor do seu token acima.`;

    const buttons = [
        [Markup.button.callback("📜 Ver Endpoints de Mensagem", `wa_endpoints_${id}`)],
        [Markup.button.callback("🔙 Voltar", `manage_${id}`)]
    ];

    await safeEdit(ctx, message, Markup.inlineKeyboard(buttons));
});

// Handler para listar endpoints de mensagem
bot.action(/^wa_endpoints_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;

    const message = `📋 *Guia de Endpoints (WUZAPI)*\n\n` +
        `Todos os comandos devem usar o método **POST** e o Header \`token: ${id}\`.\n\n` +
        `💬 *Texto*\n\`/chat/send/text\`\nPayload: \`{"Phone": "5511...", "Body": "Olá"}\`\n\n` +
        `🖼️ *Imagem*\n\`/chat/send/image\`\nPayload: \`{"Phone": "55...", "URL": "http...", "Caption": "Foto"}\`\n\n` +
        `🎬 *Vídeo*\n\`/chat/send/video\`\nPayload: \`{"Phone": "55...", "URL": "http...", "Caption": "Vídeo"}\`\n\n` +
        `🎵 *Áudio*\n\`/chat/send/audio\`\nPayload: \`{"Phone": "55...", "URL": "http..."}\`\n\n` +
        `📄 *Documento*\n\`/chat/send/document\`\nPayload: \`{"Phone": "55...", "URL": "http...", "FileName": "doc.pdf"}\``;

    ctx.reply(message, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Voltar", `wa_api_${id}`)]
        ])
    });
});

// --- Módulo de Disparo em Massa ---
const activeCampaigns = new Map();

bot.action(/^wa_mass_init_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;

    const session = await getSession(ctx.chat.id);
    if (activeCampaigns.has(ctx.chat.id)) {
        return ctx.reply("⚠️ Você já tem um disparo em andamento. Aguarde a conclusão ou cancele.", {
            ...Markup.inlineKeyboard([[Markup.button.callback("🛑 Parar Disparo Atual", `wa_stop_mass`)]])
        });
    }

    session.stage = `WA_WAITING_MASS_CONTACTS_${id}`;
    await syncSession(ctx, session);

    const text = "🚀 *Configuração de Disparo em Massa*\n\nO que deseja fazer?";
    const extra = {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
            [Markup.button.callback("🆕 Novo Disparo", `wa_mass_new_start_${id}`)],
            [Markup.button.callback("📂 Campanhas Pausadas / Pendentes", `wa_mass_list_paused_${id}`)],
            [Markup.button.callback("🔙 Voltar", `manage_${id}`)]
        ])
    };

    if (ctx.callbackQuery) {
        try { await ctx.editMessageText(text, extra); } catch (e) { await ctx.reply(text, extra); }
    } else {
        await ctx.reply(text, extra);
    }
});

bot.action(/^wa_mass_new_start_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    ctx.editMessageText("📝 *Novo Disparo*\n\nPor favor, envie a **lista de números** (um por linha).\n\nFormatos:\n`5511999998888` ou `Nome;5511999998888`", { parse_mode: "Markdown" });
});

bot.action(/^wa_mass_list_paused_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    if (!await checkOwnership(ctx, instId)) return;

    const { data, error } = await supabase
        .from('scheduled_campaigns')
        .select('*')
        .eq('inst_id', instId)
        .in('status', ['PAUSED', 'PENDING'])
        .limit(10);

    if (error || !data || data.length === 0) {
        const errMsg = "❌ Nenhuma campanha pausada ou pendente encontrada.";
        if (ctx.callbackQuery) return ctx.editMessageText(errMsg, Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", `wa_mass_init_${instId}`)]]));
        return ctx.reply(errMsg);
    }

    let msg = "📂 *Campanhas Encontradas:*\n\n";
    const buttons = [];

    data.forEach((camp, idx) => {
        const info = camp.campaign_data;
        const进度 = info.currentIndex || 0;
        const total = info.total || 0;
        msg += `${idx + 1}. Progresso: ${进度}/${total}\nStatus: ${camp.status}\n\n`;
        buttons.push([Markup.button.callback(`▶️ Retomar Campanha ${idx + 1}`, `wa_mass_resume_db_${camp.id}`)]);
    });

    buttons.push([Markup.button.callback("🔙 Voltar", `wa_mass_init_${instId}`)]);

    await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
});

bot.action(/^wa_mass_resume_db_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const dbId = ctx.match[1];

    const { data, error } = await supabase
        .from('scheduled_campaigns')
        .select('*')
        .eq('id', dbId)
        .single();

    if (error || !data) return ctx.reply("❌ Campanha não encontrada ou erro no banco.");
    if (!await checkOwnership(ctx, data.inst_id)) return;

    const camp = {
        ...data.campaign_data,
        dbId: data.id,
        status: 'RUNNING'
    };

    activeCampaigns.set(ctx.chat.id, camp);

    // Marcar como RUNNING no banco
    await supabase.from('scheduled_campaigns').update({ status: 'RUNNING' }).eq('id', dbId);

    ctx.reply(`▶️ Retomando disparo ${dbId} a partir do contato ${camp.currentIndex + 1}...`);
    runCampaign(ctx.chat.id, data.inst_id);
});

bot.action("wa_stop_mass", async (ctx) => {
    safeAnswer(ctx);
    if (activeCampaigns.has(ctx.chat.id)) {
        const camp = activeCampaigns.get(ctx.chat.id);
        camp.stopped = true;
        activeCampaigns.delete(ctx.chat.id);
        ctx.reply("🛑 Disparo interrompido pelo usuário.");
    } else {
        ctx.reply("❌ Não há nenhum disparo ativo no momento.");
    }
});

async function runCampaign(chatId, instId) {
    const campaign = activeCampaigns.get(chatId);
    if (!campaign) return;

    campaign.status = 'RUNNING';
    const sessionForId = await getSession(chatId);

    for (let i = campaign.currentIndex; i < campaign.contacts.length; i++) {
        if (campaign.status === 'CANCELLED') break;
        if (campaign.status === 'PAUSED') {
            if (campaign.lastMsgId) {
                try { await bot.telegram.deleteMessage(chatId, campaign.lastMsgId); } catch (e) { }
            }
            const pauseMsg = await bot.telegram.sendMessage(chatId, `⏸️ *Disparo Pausado*\nEnviados: ${campaign.current}/${campaign.total}`, {
                parse_mode: "Markdown",
                ...Markup.inlineKeyboard([[Markup.button.callback("▶️ Retomar", "wa_resume_mass"), Markup.button.callback("⏹️ Parar", "wa_stop_mass")]])
            });
            campaign.lastMsgId = pauseMsg.message_id;
            break;
        }

        campaign.currentIndex = i;
        const contact = campaign.contacts[i];
        const rawPhone = typeof contact === 'string' ? contact : contact.phone;
        const nameFallback = "amigo(a)";
        const contactName = (typeof contact === 'object' && contact.name) ? contact.name : nameFallback;

        const phone = rawPhone.replace(/\D/g, "");
        if (!phone) continue;

        // 1. Escolher Variação e Substituir Variáveis
        const variations = campaign.messages || [campaign.message];
        let chosenMsg = variations[Math.floor(Math.random() * variations.length)];

        // Saudações Dinâmicas e Emojis (Anti-Spam)
        const hr = new Date().getHours();
        const saudacao = hr < 12 ? "Bom dia" : hr < 18 ? "Boa tarde" : "Boa noite";
        const emjs = ["😊", "👋", "🚀", "✨", "✅", "📍", "🤝", "🙌"];
        const randomEmoji = emjs[Math.floor(Math.random() * emjs.length)];

        // Substituição de Variáveis
        chosenMsg = chosenMsg
            .replace(/\{\{nome\}\}/gi, contactName)
            .replace(/\{\{name\}\}/gi, contactName)
            .replace(/\{\{saudacao\}\}/gi, saudacao)
            .replace(/\{\{greet\}\}/gi, saudacao)
            .replace(/\{\{emoji\}\}/gi, randomEmoji);

        // 2. Validar se tem WhatsApp
        const check = await callWuzapi("/user/check", "POST", { Phone: [phone] }, instId);
        let jid = null;
        if (check.success && check.data && check.data.Users && check.data.Users[0].IsInWhatsapp) {
            jid = check.data.Users[0].JID;
        }

        if (jid) {
            // 3. Enviar baseado no tipo de mídia
            const body = { Phone: jid };
            let endpoint = "/chat/send/text";

            if (campaign.mediaType === 'text') {
                body.Body = chosenMsg;
            } else {
                // Usar campos específicos conforme documentação WUZAPI
                if (chosenMsg) body.Caption = chosenMsg;

                if (campaign.mediaType === 'photo') {
                    endpoint = "/chat/send/image";
                    body.Image = campaign.mediaData || campaign.mediaUrl; // Campo correto para imagens
                } else if (campaign.mediaType === 'video') {
                    endpoint = "/chat/send/video";
                    body.Video = campaign.mediaData || campaign.mediaUrl; // Campo correto para vídeos
                } else if (campaign.mediaType === 'audio') {
                    endpoint = "/chat/send/audio";
                    body.Audio = campaign.mediaData || campaign.mediaUrl; // Campo correto para áudios
                } else if (campaign.mediaType === 'document') {
                    endpoint = "/chat/send/document";
                    body.Document = campaign.mediaData || campaign.mediaUrl; // Campo correto para documentos
                    body.FileName = campaign.fileName || "arquivo";
                }
            }

            // Log do payload para debug (truncando base64)
            log(`[DISPARO] Enviando ${campaign.mediaType} para ${phone}`);
            log(`[DISPARO] Endpoint: ${endpoint}`);
            const debugPayload = { ...body };
            if (debugPayload.Image) debugPayload.Image = debugPayload.Image.substring(0, 50) + "...";
            if (debugPayload.Video) debugPayload.Video = debugPayload.Video.substring(0, 50) + "...";
            if (debugPayload.Audio) debugPayload.Audio = debugPayload.Audio.substring(0, 50) + "...";
            if (debugPayload.Document) debugPayload.Document = debugPayload.Document.substring(0, 50) + "...";
            log(`[DISPARO] Payload: ${JSON.stringify(debugPayload)}`);

            const result = await callWuzapi(endpoint, "POST", body, instId);

            if (result.success) {
                campaign.current++;
                if (!campaign.successNumbers) campaign.successNumbers = [];
                campaign.successNumbers.push(phone);
                log(`[DISPARO] ✅ Enviado com sucesso para ${phone}`);
            } else {
                if (!campaign.failedNumbers) campaign.failedNumbers = [];
                campaign.failedNumbers.push(phone);
                log(`[DISPARO] ❌ Erro ao enviar para ${phone}: ${JSON.stringify(result)}`);
            }
        }

        // Progresso e Persistência (Salvar no banco a cada 5 disparos)
        if ((i + 1) % 5 === 0 || (i + 1) === campaign.total) {
            if (campaign.lastMsgId) {
                try { await bot.telegram.deleteMessage(chatId, campaign.lastMsgId); } catch (e) { }
            }

            // Se for campanha persistente, salvar progresso no banco
            if (campaign.dbId) {
                const updateData = {
                    campaign_data: {
                        ...campaign,
                        currentIndex: i + 1,
                        current: campaign.current,
                        lastMsgId: null,
                        successNumbers: campaign.successNumbers,
                        failedNumbers: campaign.failedNumbers
                    }
                };
                await supabase.from('scheduled_campaigns').update(updateData).eq('id', campaign.dbId);
            }

            const pct = Math.round(((i + 1) / campaign.total) * 100);
            const filled = "🟩".repeat(Math.floor(pct / 10));
            const empty = "⬜".repeat(10 - Math.floor(pct / 10));

            const lastMsg = `🚀 *Progresso do Disparo*\n\n` +
                `${filled}${empty} ${pct}%\n\n` +
                `📊 *Status:* ${i + 1} de ${campaign.total}\n` +
                `✅ *Sucesso:* ${campaign.current}\n` +
                `⏳ *Aguardando:* ${campaign.total - (i + 1)}\n` +
                `📱 *Instância:* \`${instId}\``;

            const isLast = (i + 1) === campaign.total;
            const buttons = isLast ? [] : [[Markup.button.callback("⏸️ Pausar", "wa_pause_mass"), Markup.button.callback("⏹️ Parar", "wa_stop_mass")]];

            const sent = await bot.telegram.sendMessage(chatId, lastMsg, {
                parse_mode: "Markdown",
                ...Markup.inlineKeyboard(buttons)
            });
            campaign.lastMsgId = sent.message_id;
        }

        // Delay
        if (i < campaign.contacts.length - 1 && (campaign.status === 'RUNNING' || campaign.status === 'READY')) {
            const min = parseInt(campaign.minDelay) || 5;
            const max = parseInt(campaign.maxDelay) || 15;
            const d = Math.floor(Math.random() * (max - min + 1) + min) * 1000;

            log(`[DELAY] Dormindo por ${d / 1000}s antes do próximo contato...`);
            await new Promise(r => setTimeout(r, d));
        }
    }

    if (campaign.status === 'RUNNING' && campaign.currentIndex === campaign.contacts.length - 1) {
        const successRate = ((campaign.current / campaign.total) * 100).toFixed(1);

        // Salvar relatório na sessão
        const session = await getSession(chatId);
        if (!session.reports) session.reports = {};
        session.reports[campaign.instId] = {
            total: campaign.total,
            success: campaign.current,
            failed: campaign.total - campaign.current,
            successRate,
            successNumbers: campaign.successNumbers || [],
            failedNumbers: campaign.failedNumbers || [],
            timestamp: new Date().toLocaleString('pt-BR')
        };
        await saveSession(chatId, session);

        // Marcar como COMPLETED no banco se for uma campanha persistente
        if (campaign.dbId) {
            await supabase.from('scheduled_campaigns').update({ status: 'COMPLETED' }).eq('id', campaign.dbId);
        }

        if (campaign.lastMsgId) {
            try { await bot.telegram.deleteMessage(chatId, campaign.lastMsgId); } catch (e) { }
            campaign.lastMsgId = null;
        }

        const reportMsg = `✅ *Disparo Finalizado!*\n\n` +
            `📊 *Estatísticas:*\n` +
            `• Total de contatos: ${campaign.total}\n` +
            `• Enviados com sucesso: ${campaign.current}\n` +
            `• Taxa de sucesso: ${successRate}%\n` +
            `• Instância: \`${campaign.instId}\``;

        await bot.telegram.sendMessage(chatId, reportMsg, {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
                [Markup.button.callback("📊 Ver Relatório Completo", `wa_report_${campaign.instId}`)],
                [Markup.button.callback("🔙 Voltar ao Menu", `manage_${campaign.instId}`)]
            ])
        });
        activeCampaigns.delete(chatId);
    }
}

bot.action("wa_pause_mass", async (ctx) => {
    safeAnswer(ctx);
    if (activeCampaigns.has(ctx.chat.id)) {
        const camp = activeCampaigns.get(ctx.chat.id);
        camp.status = 'PAUSED';

        // Atualizar status no banco
        if (camp.dbId) {
            await supabase.from('scheduled_campaigns').update({ status: 'PAUSED' }).eq('id', camp.dbId);
        }

        ctx.reply("⏳ Pausando disparo... o progresso será salvo para que você possa continuar depois.");
    }
});

bot.action("wa_resume_mass", async (ctx) => {
    safeAnswer(ctx);
    const camp = activeCampaigns.get(ctx.chat.id);
    if (camp && camp.status === 'PAUSED') {
        ctx.reply("▶️ Retomando disparo...");
        runCampaign(ctx.chat.id, camp.instId);
    }
});

bot.action("wa_stop_mass", async (ctx) => {
    safeAnswer(ctx);
    if (activeCampaigns.has(ctx.chat.id)) {
        activeCampaigns.get(ctx.chat.id).status = 'CANCELLED';
        activeCampaigns.delete(ctx.chat.id);
        ctx.reply("🛑 Disparo cancelado definitivamente.");
    }
});

// Handlers para Agendamento
bot.action(/^wa_mass_now_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    if (!await checkOwnership(ctx, instId)) return;
    const session = await getSession(ctx.chat.id);

    const camp = {
        instId,
        contacts: session.mass_contacts,
        message: session.mass_msgs[0],
        messages: session.mass_msgs,
        mediaType: session.mass_media_type,
        mediaUrl: session.mass_media_url,
        mediaData: session.mass_media_data,
        fileName: session.mass_file_name,
        minDelay: session.temp_mass_min,
        maxDelay: session.temp_mass_max,
        currentIndex: 0,
        current: 0,
        total: session.mass_contacts.length,
        status: 'READY',
        lastMsgId: null,
        successNumbers: [],
        failedNumbers: []
    };

    // Criar registro na tabela de campanhas agendadas com agendamento imediato (status PENDING/RUNNING)
    const { data, error } = await supabase.from('scheduled_campaigns').insert({
        chat_id: String(ctx.chat.id),
        inst_id: instId,
        scheduled_for: new Date().toISOString(),
        campaign_data: camp,
        status: 'RUNNING'
    }).select().single();

    if (error) {
        log(`[PERSIST ERR] ${error.message}`);
        return ctx.reply("❌ Erro ao iniciar persistência da campanha. O disparo continuará apenas em memória.");
    }

    camp.dbId = data.id;
    activeCampaigns.set(ctx.chat.id, camp);

    session.stage = "READY";
    await syncSession(ctx, session);

    ctx.editMessageText("🚀 Iniciando disparo agora...");
    runCampaign(ctx.chat.id, instId);
});

bot.action(/^wa_mass_sched_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    if (!await checkOwnership(ctx, instId)) return;
    const session = await getSession(ctx.chat.id);

    session.stage = `WA_WAITING_MASS_SCHEDULE_${instId}`;
    await syncSession(ctx, session);

    ctx.editMessageText("📅 *Agendamento de Disparo*\n\nPor favor, envie a **data e hora** desejada no formato: `DD/MM/AAAA HH:MM`.\n\nExemplo: `15/02/2026 14:30`", { parse_mode: "Markdown" });
});

bot.action(/^wa_set_ai_prompt_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const session = await getSession(ctx.chat.id);
    session.stage = `WA_WAITING_AI_PROMPT_${id}`;
    await syncSession(ctx, session);
    ctx.reply("📝 *Definir Instruções da IA*\n\nDigite como o robô deve se comportar e quais informações ele deve usar para atender seus clientes.\n\nExemplo:\n`Você é o assistente da Loja Venux. Seja educado e tire dúvidas sobre nossos preços de planos Pro.`", { parse_mode: "Markdown" });
});

// --- Menu de Follow-ups ---
async function renderFollowupMenu(ctx, instId) {
    const session = await getSession(ctx.chat.id);
    const inst = session.whatsapp.instances.find(i => i.id === instId);
    if (!inst) return ctx.reply("❌ Instância não encontrada.");

    const enabled = inst.fu_enabled || false;
    const hours = inst.fu_hours || 24;
    const maxNudges = inst.fu_max || 1;
    const msgs = inst.fu_msgs || ["Oi! Vi que não me respondeu, ainda tem interesse?"];

    const text = `🔔 *Configuração de Follow-ups (${instId})*\n\n` +
        `O robô enviará lembretes automáticos se o lead parar de responder.\n\n` +
        `🔋 *Status:* ${enabled ? "✅ Ativado" : "❌ Desativado"}\n` +
        `⏰ *Esperar:* \`${hours} horas\`\n` +
        `🔢 *Máximo de Lembretes:* \`${maxNudges}\`\n` +
        `✉️ *Mensagens:* \n${msgs.map((m, i) => `${i + 1}. ${m}`).join("\n")}`;

    const buttons = [
        [Markup.button.callback(enabled ? "🔴 Desativar" : "🟢 Ativar", `wa_fu_toggle_${instId}`)],
        [Markup.button.callback("⏰ Definir Tempo (horas)", `wa_fu_set_hours_${instId}`)],
        [Markup.button.callback("🔢 Definir Qnt. Lembretes", `wa_fu_set_max_${instId}`)],
        [Markup.button.callback("✉️ Editar Mensagens", `wa_fu_set_msgs_${instId}`)],
        [Markup.button.callback("🔙 Voltar", `wa_ai_menu_${instId}`)]
    ];

    await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
}

bot.action(/^wa_ai_followup_menu_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    await renderFollowupMenu(ctx, id);
});

bot.action(/^wa_fu_toggle_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const inst = await checkOwnership(ctx, id);
    if (!inst) return;
    const session = await getSession(ctx.chat.id);
    inst.fu_enabled = !inst.fu_enabled;
    await syncSession(ctx, session);
    await renderFollowupMenu(ctx, id);
});

bot.action(/^wa_fu_set_hours_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const session = await getSession(ctx.chat.id);
    const inst = await checkOwnership(ctx, id);
    if (!inst) return;
    const current = inst.fu_hours || 24;
    const msg = `⏰ Quantas **horas** o robô deve esperar antes de cobrar o lead? (Apenas números)` +
        (current ? `\n\n📌 *Valor Atual:* _${current}h_` : "");
    const buttons = current ? [[Markup.button.callback(`✅ Manter Atual`, `wa_ai_keep_fu_hours_${id}`)]] : [];

    ctx.reply(msg, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^wa_fu_set_max_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const session = await getSession(ctx.chat.id);
    const inst = await checkOwnership(ctx, id);
    if (!inst) return;
    const current = inst.fu_max || 1;
    const msg = `🔢 Quantos **lembretes** (cobranças) o robô deve enviar no máximo? (Ex: 3)` +
        (current ? `\n\n📌 *Valor Atual:* _${current}_` : "");
    const buttons = current ? [[Markup.button.callback(`✅ Manter Atual`, `wa_ai_keep_fu_max_${id}`)]] : [];

    ctx.reply(msg, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^wa_fu_set_msgs_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const session = await getSession(ctx.chat.id);
    const inst = await checkOwnership(ctx, id);
    if (!inst) return;
    const current = (inst.fu_msgs || []).join("; ");
    const msg = `✉️ Envie as mensagens de follow-up separadas por **ponto e vírgula** (;).\n\nExemplo:\n` +
        `\`Oi, tudo bem?;Ainda tem interesse no produto?;Fico no aguardo!\`\n\n` +
        (current ? `📌 *Mensagens Atuais:* \n_${current}_` : "");
    const buttons = current ? [[Markup.button.callback(`✅ Manter Atual`, `wa_ai_keep_fu_msgs_${id}`)]] : [];

    await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
});

// Handler para relatório detalhado
bot.action(/^wa_report_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    if (!await checkOwnership(ctx, instId)) return;
    const session = await getSession(ctx.chat.id);
    const report = session.reports ? session.reports[instId] : null;

    let reportMsg = `📊 *Relatório Completo de Disparo*\n\n` +
        `🔹 *Instância:* \`${instId}\`\n`;

    if (report) {
        reportMsg += `🔹 *Data:* ${report.timestamp}\n` +
            `🔹 *Status:* Finalizado\n` +
            `✅ *Sucessos (${report.success}):*\n${report.successNumbers.length > 0 ? report.successNumbers.join(", ") : "Nenhum"}\n\n` +
            `❌ *Falhas (${report.failed}):*\n${report.failedNumbers.length > 0 ? report.failedNumbers.join(", ") : "Nenhuma"}\n\n`;
    } else {
        reportMsg += `❌ Relatório não encontrado ou expirado.`;
    }

    reportMsg += `\n💡 *Dica:* Para iniciar um novo disparo, volte ao menu da instância e selecione "🚀 Disparo em Massa".`;

    await safeEdit(ctx, reportMsg, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Voltar ao Menu", `manage_${instId}`)]
        ])
    });
});

// Handlers Individuais
// Função de Polling para verificar conexão em tempo real (Strict Mode)
async function startConnectionPolling(chatId, instId) {
    // Se já existe um polling para essa instância, encerra para evitar duplicidade
    if (activePolls.has(instId)) {
        clearInterval(activePolls.get(instId));
    }

    let attempts = 0;
    const maxAttempts = 45; // 1.5 minutos (2s * 45)

    const interval = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
            clearInterval(interval);
            activePolls.delete(instId);
            return;
        }

        const stats = await callWuzapi(`/session/status`, "GET", null, instId);
        let isFullyLoggedIn = false;

        if (stats.success && stats.data) {
            const d = stats.data;
            // Critério Rigoroso: Apenas LoggedIn ou loggedIn confirmam a conexão real do WhatsApp
            isFullyLoggedIn = (d.LoggedIn === true || d.loggedIn === true || d.status === "LoggedIn");
        }

        if (isFullyLoggedIn) {
            clearInterval(interval);
            activePolls.delete(instId);
            bot.telegram.sendMessage(chatId, `✅ *WhatsApp Conectado com Sucesso!* \n\nA instância \`${instId}\` agora está online e pronta para uso no Venux.`, { parse_mode: "Markdown" });
        }
    }, 2000);

    activePolls.set(instId, interval);
}

bot.action(/^wa_qr_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    ctx.reply("⏳ Gerando QR Code...");

    await ensureWebhookSet(id);

    // Antes de gerar, verifica se já não está logado
    const stats = await callWuzapi(`/session/status`, "GET", null, id);
    if (stats.success && (stats.data?.LoggedIn || stats.data?.loggedIn)) {
        return ctx.reply("✅ Você já está conectado!");
    }

    // WUZAPI: connect
    await callWuzapi("/session/connect", "POST", { Immediate: true }, id);

    // Inicia polling proativo
    startConnectionPolling(ctx.chat.id, id);

    await new Promise(r => setTimeout(r, 1000));
    const res = await callWuzapi("/session/qr", "GET", null, id);

    if (res.data && res.data.QRCode) {
        const qrBase64 = res.data.QRCode.split(",")[1];
        ctx.replyWithPhoto({ source: Buffer.from(qrBase64, "base64") }, { caption: "📷 Escaneie para conectar\n\n_O bot avisará assim que detectar o login com sucesso._", parse_mode: "Markdown" });
    } else {
        log(`[QR FAIL] Res: ${JSON.stringify(res)}`);
        ctx.reply("❌ Erro ao gerar QR Code. Certifique-se de que a instância não esteja já online. Caso persista, dê Logout e tente novamente.");
    }
});

bot.action(/^wa_pair_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;

    await ensureWebhookSet(id);

    // Antes de gerar, verifica se já não está logado
    const stats = await callWuzapi(`/session/status`, "GET", null, id);
    if (stats.success && (stats.data?.LoggedIn || stats.data?.loggedIn)) {
        return ctx.reply("✅ Você já está conectado!");
    }

    const session = await getSession(ctx.chat.id);
    session.stage = `WA_WAITING_PAIR_PHONE_${id}`;
    await syncSession(ctx, session);

    const msg = "🔢 *Pareamento por Código*\n\nPor favor, digite o seu **número do WhatsApp** (com DDD e DDI) para que o sistema envie a notificação para o seu celular.\n\nExemplo: `5511999998888`";
    await safeEdit(ctx, msg, null);
});

// Opção "Link Público" removida.

// Função auxiliar para renderizar o menu de Webhook
async function renderWebhookMenu(ctx, id) {
    const res = await callWuzapi("/webhook", "GET", null, id);
    let text = `🌐 *Gerenciamento de Webhook (${id})*\n\n`;
    const buttons = [];

    if (res.success && res.data && (res.data.webhook || (res.data.subscribe && res.data.subscribe.length > 0))) {
        const url = res.data.webhook || "Não configurada";
        let events = res.data.subscribe || [];
        if (typeof events === "string") events = [events]; // Robustez para versões que retornam string
        text += `📍 *URL Atual:* \`${url}\`\n🎭 *Eventos:* \`${events.join(", ") || "Nenhum"}\`\n\n`;
        buttons.push([Markup.button.callback("✏️ Configurar URL", `wa_set_web_${id}`)]);
        buttons.push([Markup.button.callback("🎭 Gerenciar Eventos", `wa_events_${id}`)]);
        buttons.push([Markup.button.callback("🗑️ Remover Webhook", `wa_del_web_${id}`)]);
    } else {
        text += "❌ Nenhum webhook configurado.\n\n";
        buttons.push([Markup.button.callback("➕ Configurar Webhook", `wa_set_web_${id}`)]);
    }
    buttons.push([Markup.button.callback("🔙 Voltar", `manage_${id}`)]);

    await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
}

bot.action(/^wa_web_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    await renderWebhookMenu(ctx, id);
});

// Handler unificado para configurar URL
bot.action(/^wa_set_web_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const session = await getSession(ctx.chat.id);
    session.stage = `WA_WAITING_WEBHOOK_URL_${id}`;
    await syncSession(ctx, session);

    const msg = "🔗 Por favor, envie a **URL** do novo webhook (ex: https://meusite.com/webhook):";
    const sent = await ctx.editMessageText(msg, { parse_mode: "Markdown" }).catch(() => ctx.reply(msg, { parse_mode: "Markdown" }));
    if (sent && sent.message_id) {
        session.last_ui_id = sent.message_id;
        await syncSession(ctx, session);
    }
});

bot.action(/^wa_del_web_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;

    // Obter UUID para limpar também no Admin
    const statusRes = await callWuzapi("/session/status", "GET", null, id);
    const uuid = statusRes?.data?.id;

    // 1. Remover via endpoint oficial
    const res = await callWuzapi("/webhook", "DELETE", null, id);

    // 2. Limpar via Admin se houver UUID
    if (uuid) {
        await callWuzapi(`/admin/users/${uuid}`, "PUT", { webhook: "", events: "Message", Active: false });
    }

    ctx.answerCbQuery(res.success ? "✅ Webhook removido!" : "❌ Falha ao remover.");
    await renderWebhookMenu(ctx, id);
});

bot.action(/^wa_events_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const res = await callWuzapi("/webhook", "GET", null, id);
    if (!res.success || !res.data) return ctx.reply("❌ Não foi possível carregar eventos.");

    const current = res.data.subscribe || [];
    const allEvents = ["All", "Message", "ReadReceipt", "Presence", "HistorySync", "ChatPresence"];
    const buttons = allEvents.map(e => [
        Markup.button.callback(`${current.includes(e) ? "✅" : "❌"} ${e}`, `wa_toggle_ev_${id}_${e}`)
    ]);
    buttons.push([Markup.button.callback("🔙 Voltar", `wa_web_${id}`)]);

    ctx.editMessageText("🎭 *Gerenciar Eventos*\n\nSelecione os eventos que deseja receber:", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(buttons)
    });
});

bot.action(/^wa_toggle_ev_(.+)_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const event = ctx.match[2];

    const res = await callWuzapi("/webhook", "GET", null, id);
    if (!res.success || !res.data) return;

    let events = res.data.subscribe || [];
    if (event === "All") {
        events = events.includes("All") ? [] : ["All"];
    } else {
        // Se colocar um específico, tira o "All"
        events = events.filter(e => e !== "All");
        if (events.includes(event)) {
            events = events.filter(e => e !== event);
        } else {
            events.push(event);
        }
    }

    // Obter UUID para persistência redundante
    const statusRes = await callWuzapi("/session/status", "GET", null, id);
    const uuid = statusRes?.data?.id;
    const currentUrl = res.data.webhook || "";

    const robustPayload = {
        webhook: currentUrl,
        WebhookURL: currentUrl,
        events: events,
        subscribe: events,
        Active: true,
        active: true
    };

    // 1. Salvar no endpoint padrão (Array)
    await callWuzapi("/webhook", "PUT", robustPayload, id);

    // 2. Salvar via Admin (String)
    if (uuid) {
        await callWuzapi(`/admin/users/${uuid}`, "PUT", {
            webhook: currentUrl,
            events: events.join(" "), // Formato string para admin
            subscribe: events.includes("All") ? "All" : events.join(","),
            Active: true
        });
    }

    ctx.answerCbQuery("✅ Eventos atualizados!");

    // Re-render do menu de eventos
    const current = events;
    const allEvents = ["All", "Message", "ReadReceipt", "Presence", "HistorySync", "ChatPresence"];
    const buttons = allEvents.map(e => [
        Markup.button.callback(`${current.includes(e) ? "✅" : "❌"} ${e}`, `wa_toggle_ev_${id}_${e}`)
    ]);
    buttons.push([Markup.button.callback("🔙 Voltar", `wa_web_${id}`)]);

    ctx.editMessageText("🎭 *Gerenciar Eventos*\n\nSelecione os eventos que deseja receber:", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(buttons)
    });
});

bot.action(/^wa_conf_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;

    // Buscar status de presença atual (embora a API não retorne o estado, simulamos via sessão)
    const session = await getSession(ctx.chat.id);
    const inst = session.whatsapp.instances.find(i => i.id === id) || {};
    const presence = inst.presence || "available";

    ctx.editMessageText(`⚙️ *Configurações (${id})*\n\nAjuste o comportamento do número nesta instância:`, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
            [Markup.button.callback(`${presence === "available" ? "🟢 Online" : "⚪ Offline"} (Trocar)`, `wa_toggle_presence_${id}`)],
            [Markup.button.callback("🔙 Voltar", `manage_${id}`)]
        ])
    });
});

bot.action(/^wa_toggle_presence_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const session = await getSession(ctx.chat.id);
    const inst = session.whatsapp.instances.find(i => i.id === id);
    if (!inst) return;

    const current = inst.presence || "available";
    const next = current === "available" ? "unavailable" : "available";

    const res = await callWuzapi("/user/presence", "POST", { type: next }, id);
    if (res.success) {
        inst.presence = next;
        await syncSession(ctx, session);
        ctx.answerCbQuery(`✅ Status alterado para ${next === "available" ? "Online" : "Ocupado"}`);
        // Refresh menu
        ctx.editMessageText(`⚙️ *Configurações (${id})*\n\nAjuste o comportamento do número nesta instância:`, {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
                [Markup.button.callback(`${next === "available" ? "🟢 Online" : "⚪ Offline"} (Trocar)`, `wa_toggle_presence_${id}`)],
                [Markup.button.callback("🔙 Voltar", `manage_${id}`)]
            ])
        });
    } else {
        ctx.answerCbQuery("❌ Falha ao alterar presença.");
    }
});

function generateSystemPrompt(inst) {
    if (!inst.niche || inst.niche === 'legacy' || inst.niche === 'custom') {
        return inst.ai_prompt || "Você é um assistente virtual prestativo.";
    }

    const data = inst.niche_data || {};
    const agentName = data.agent_name || (inst.niche === 'medical_clinic' ? 'Dani' : 'Balbis');
    const company = data.company_name || 'nossa empresa';
    const strategy = data.rules || 'Seja gentil, use o nome do lead e valide cada resposta antes de prosseguir.';

    // Estrutura Baseada no Modelo de Performance n8n
    return `
# PERSONA E ESTRATÉGIA
Você se chama ${agentName}. 
Você é a assistente virtual da empresa ${company}. 

ESTRATÉGIA DE CONDUÇÃO: 
"${strategy}"

# MODO HUMANIZADO (HIGH-CONVERSION)
- Use gírias leves se o tom for amigável.
- Responda apenas o necessário. Nunca dê textos longos.
- ESPELHAMENTO SOCIAL: Reaja ao que o cliente diz (Ex: "Que legal!", "Entendo") antes de prosseguir.

# REGRAS DE OURO (NUNCA QUEBRE)
1. SAUDAÇÃO INTELIGENTE: Se apresente apenas na PRIMEIRA mensagem. Se o histórico já mostra que você falou oi, vá direto ao assunto.
2. ANTI-REPETIÇÃO (CRÍTICO): LEIA O HISTÓRICO. Se o cliente já respondeu (ex: disse "comprar"), NÃO pergunte de novo "quer comprar ou alugar?". Assuma a resposta e avance.
3. VALIDAÇÃO DE ESTADO: Antes de perguntar, verifique: "O cliente já me disse isso?". Se sim, pule para a próxima pergunta.
4. PACIÊNCIA: Faça EXATAMENTE UMA pergunta por mensagem.

# FLUXO DE ATENDIMENTO (FUNIL)
${inst.niche === 'real_estate' ? `
1. Identificar se quer Comprar ou Alugar. (Se ele já disse 'quero comprar', pule para o passo 2). (Se ele já disse 'quero comprar um ap', pule direto para o passo 2).
2. Identificar Localização desejada.
3. Identificar Faixa de Preço/Renda.
4. Agendar conversa com corretor.` :
            inst.niche === 'medical_clinic' ? `
    1. Identificar a necessidade / especialidade.
2. Verificar convênio(${data.plans || 'diversos'}).
3. Direcionar para agendamento: ${data.booking_link || 'solicite suporte'}.` :
                `1. Qualificar a necessidade geral.
2. Apresentar solução / serviço.
3. Coletar contato / agendar.`}

# FINALIZAÇÃO
Ao concluir a qualificação, use a tag [QUALIFICADO].
Se não souber responder ou pedirem humano, use a tag [TRANSFERIR].
`;
}

// --- Funções Auxiliares do Mágico AI (Wizard) ---
async function triggerRealEstateWizard(ctx, instId, step) {
    const session = await getSession(ctx.chat.id);
    const inst = session.whatsapp.instances.find(i => i.id === instId);
    if (!inst) return;

    const steps = [
        { field: 'company_name', label: 'Nome da Imobiliária', icon: '🏢', quest: 'Qual o nome da sua imobiliária?' },
        { field: 'greeting', label: 'Mensagem de Saudação', icon: '👋', quest: 'Como a IA deve iniciar a conversa?' },
        { field: 'address', label: 'Endereço/Atuação', icon: '📍', quest: 'Qual o endereço físico ou área que atendem?' },
        { field: 'products', label: 'O que você vende?', icon: '🏠', quest: 'Descreva os imóveis (Ex: Apartamentos de luxo, MCMV, Locação).' },
        { field: 'funnel', label: 'Funil de Qualificação', icon: '🎯', quest: 'O que a IA pergunta primeiro? (Ex: Comprar ou Alugar).' },
        { field: 'bio', label: 'Contexto (Bio)', icon: '📖', quest: 'Quem é você? Uma pequena bio da empresa para a IA saber sua história.' },
        { field: 'rules', label: 'Regras e Objeções', icon: '🚫', quest: 'Quais as regras proibidas? (Ex: Não aceita permuta, sempre pedir fone).' }
    ];

    if (step <= steps.length) {
        const s = steps[step - 1];
        const current = inst.niche_data?.[s.field];
        session.stage = `WA_AI_CONF_RE_${s.field.toUpperCase()}_${instId}`;
        await syncSession(ctx, session);

        const msg = `${s.icon} *Passo ${step}/9: ${s.label}*\n\n${s.quest}` +
            (current ? `\n\n📌 *Valor Atual:* _${current}_` : "");
        const buttons = current ? [[Markup.button.callback(`✅ Manter Atual`, `wa_ai_keep_re_${s.field}_${instId}`)]] : [];

        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    } else {
        const styles = [
            [Markup.button.callback("😊 Amigável e com Emojis", `wa_ai_re_style_${instId}_amigavel`)],
            [Markup.button.callback("💼 Formal e Profissional", `wa_ai_re_style_${instId}_formal`)],
            [Markup.button.callback("🎯 Direto e Persuasivo", `wa_ai_re_style_${instId}_direto`)],
            [Markup.button.callback("😎 Descontraído", `wa_ai_re_style_${instId}_descontraido`)]
        ];
        await safeEdit(ctx, "🎭 *Passo 8/9: Estilo de Conversa*\n\nComo a IA deve falar com os clientes?", Markup.inlineKeyboard(styles));
    }
}

async function triggerMedicalWizard(ctx, instId, step) {
    const session = await getSession(ctx.chat.id);
    const inst = session.whatsapp.instances.find(i => i.id === instId);
    if (!inst) return;

    const steps = [
        { field: 'company_name', label: 'Nome da Clínica', icon: '🏥', quest: 'Qual o nome da sua clínica?' },
        { field: 'specialties', label: 'Especialidades', icon: '🩺', quest: 'Quais especialidades atendem? (Ex: Dentista, Nutricionista).' },
        { field: 'plans', label: 'Convênios', icon: '💳', quest: 'Aceitam convênios? Quais? (Ex: Unimed, Bradesco).' },
        { field: 'booking_link', label: 'Link de Agenda', icon: '🔗', quest: 'Qual o link para agendamento online?' },
        { field: 'address', label: 'Endereço', icon: '📍', quest: 'Qual o endereço da unidade?' },
        { field: 'greeting', label: 'Saudação', icon: '👋', quest: 'Como a IA deve dar as boas vindas?' },
        { field: 'bio', label: 'Contexto (Bio)', icon: '📖', quest: 'Defina a personalidade da IA (Ex: Atenciosa, Formal).' }
    ];

    if (step <= steps.length) {
        const s = steps[step - 1];
        const current = inst.niche_data?.[s.field];
        session.stage = `WA_AI_CONF_MC_${s.field.toUpperCase()}_${instId}`;
        await syncSession(ctx, session);

        const msg = `${s.icon} *Passo ${step}/8: ${s.label}*\n\n${s.quest}` +
            (current ? `\n\n📌 *Valor Atual:* _${current}_` : "");
        const buttons = current ? [[Markup.button.callback(`✅ Manter Atual`, `wa_ai_keep_mc_${s.field}_${instId}`)]] : [];

        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    } else {
        const styles = [
            [Markup.button.callback("🤝 Acolhedor e Humano", `wa_ai_re_style_${instId}_amigavel`)],
            [Markup.button.callback("💼 Clínico e Profissional", `wa_ai_re_style_${instId}_formal`)],
            [Markup.button.callback("⚡ Rápido e Eficiente", `wa_ai_re_style_${instId}_direto`)]
        ];
        await safeEdit(ctx, "🎭 *Passo 8/8: Estilo de Conversa*\n\nComo a IA deve se portar no atendimento?", Markup.inlineKeyboard(styles));
    }
}

async function triggerGenericWizard(ctx, instId, step) {
    const session = await getSession(ctx.chat.id);
    const inst = session.whatsapp.instances.find(i => i.id === instId);
    if (!inst) return;

    const steps = [
        { field: 'company_name', label: 'Nome da Empresa', icon: '🏢', quest: 'Qual o nome do seu negócio?' },
        { field: 'goal', label: 'Objetivo', icon: '🎯', quest: 'Qual o objetivo principal? (Ex: Vender, Tirar dúvidas).' },
        { field: 'products', label: 'O que você faz?', icon: '📦', quest: 'Descreva seus produtos ou serviços.' },
        { field: 'rules', label: 'Regras', icon: '🚫', quest: 'O que a IA NÃO pode falar ou fazer?' },
        { field: 'greeting', label: 'Saudação', icon: '👋', quest: 'Como o robô deve começar o papo?' },
        { field: 'bio', label: 'Identidade', icon: '🧠', quest: 'Quem é você? (Ex: Assistente virtual da Loja X).' }
    ];

    if (step <= steps.length) {
        const s = steps[step - 1];
        const current = inst.niche_data?.[s.field];
        session.stage = `WA_AI_CONF_GN_${s.field.toUpperCase()}_${instId}`;
        await syncSession(ctx, session);

        const msg = `${s.icon} *Passo ${step}/7: ${s.label}*\n\n${s.quest}` +
            (current ? `\n\n📌 *Valor Atual:* _${current}_` : "");
        const buttons = current ? [[Markup.button.callback(`✅ Manter Atual`, `wa_ai_keep_gn_${s.field}_${instId}`)]] : [];

        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    } else {
        const styles = [
            [Markup.button.callback("😊 Amigável", `wa_ai_re_style_${instId}_amigavel`)],
            [Markup.button.callback("💼 Sério", `wa_ai_re_style_${instId}_formal`)],
            [Markup.button.callback("😎 Descontraído", `wa_ai_re_style_${instId}_descontraido`)]
        ];
        await safeEdit(ctx, "🎭 *Passo 7/7: Estilo Final*\n\nEscolha o jeito que a IA falará:", Markup.inlineKeyboard(styles));
    }
}

// --- Módulo AI SDR / Suporte ---
async function renderAiMenu(ctx, instId) {
    const session = await getSession(ctx.chat.id);
    const inst = session.whatsapp.instances.find(i => i.id === instId);
    if (!inst) return ctx.reply("❌ Instância não encontrada.");

    const isEnabled = inst.ai_enabled || false;
    const isNiche = inst.niche && inst.niche !== 'legacy' && inst.niche !== 'custom';

    let instructionsText = "";
    if (isNiche) {
        const data = inst.niche_data || {};
        const nicheNames = { 'real_estate': '🏠 Imobiliária', 'medical_clinic': '🏥 Clínica Médica', 'generic': '🤖 Agente Genérico' };
        instructionsText = `🧬 *DNA do Agente (${nicheNames[inst.niche] || inst.niche})*\n\n` +
            `🏢 *Empresa:* ${data.company_name || '_Não configurado_'}\n` +
            `📍 *Atuação:* ${data.address || '_Não configurado_'}\n` +
            `🏠 *Produtos:* ${data.products || '_Não configurado_'}\n` +
            `🎯 *Funil:* ${data.funnel || 'Padrão'}\n` +
            `📜 *Regras:* ${data.rules ? (data.rules.substring(0, 40) + "...") : '_Não configurado_'}\n` +
            `🎭 *Estilo:* ${data.style || 'Amigável'} / ${data.tone || 'Acolhedor'}`;
    } else {
        const prompt = inst.ai_prompt || "Nenhuma instrução definida. (A IA agirá de forma genérica)";
        instructionsText = `📝 *Instruções (Manual):* \n\`${prompt.substring(0, 100)}${prompt.length > 100 ? "..." : ""}\``;
    }

    const text = `🤖 *Configuração de IA SDR (${instId})*\n\n` +
        `🔋 *Status:* ${isEnabled ? "✅ Ativado" : "❌ Desativado"}\n\n` +
        instructionsText;

    const buttons = [];

    // Linha 1: Ativar/Desativar
    buttons.push([Markup.button.callback(isEnabled ? "🔴 Desativar IA" : "🟢 Ativar IA", `wa_toggle_ai_${instId}`)]);

    // Linha 2: Nicho (Principal se estiver em modo fábrica)
    if (isNiche) {
        let btnLabel = "⚙️ Configurar Perfil";
        let action = `wa_ai_wizard_re_${instId}`;

        if (inst.niche === 'real_estate') {
            btnLabel = "⚙️ Configurar Imobiliária";
            action = `wa_ai_wizard_re_${instId}`;
        } else if (inst.niche === 'medical_clinic') {
            btnLabel = "⚙️ Configurar Clínica";
            action = `wa_ai_wizard_mc_${instId}`;
        } else if (inst.niche === 'generic') {
            btnLabel = "⚙️ Configurar Negócio";
            action = `wa_ai_wizard_gn_${instId}`;
        }
        buttons.push([Markup.button.callback(btnLabel, action)]);
        buttons.push([Markup.button.callback("🎭 Mudar de Modelo (NICHO)", `wa_ai_niche_menu_${instId}`)]);
    } else {
        buttons.push([Markup.button.callback("🎭 Modelos de Agente (NICHOS)", `wa_ai_niche_menu_${instId}`)]);
        buttons.push([Markup.button.callback("📝 Prompt Manual (Custom)", `wa_set_ai_prompt_${instId}`)]);
    }

    // Linha 3: Extras
    buttons.push([Markup.button.callback("⏱️ Tempo de Reativação", `wa_ai_resume_time_${instId}`)]);

    // Só mostra assistente se não for nicho (nichos usam o wizard)
    if (!isNiche) {
        buttons.push([Markup.button.callback("🧙‍♂️ Mágico de Prompt (Auxílio)", `wa_ai_wizard_${instId}`)]);
    }

    buttons.push([Markup.button.callback("🔔 Follow-ups", `wa_ai_followup_menu_${instId}`)]);
    buttons.push([Markup.button.callback("🔄 Sincronizar Webhook", `wa_ai_sync_web_${instId}`)]);
    buttons.push([Markup.button.callback("🔙 Voltar", `manage_${instId}`)]);

    if (ctx.updateType === "callback_query") {
        await ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
    } else {
        await ctx.reply(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
    }
}

bot.action(/^wa_ai_menu_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    await ensureWebhookSet(id); // Sincroniza ao abrir o menu
    await renderAiMenu(ctx, id);
});

bot.action(/^wa_ai_niche_menu_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const text = `🎭 *Modelos de Agente (NICHOS)*\n\n` +
        `Escolha um modelo pré-configurado para sua instância. Isso irá gerar regras e comportamentos automáticos baseados no seu ramo.\n\n` +
        `🏠 **Imobiliária**: Qualificação de leads, tipos de imóvel, rodízio.\n` +
        `🏥 **Clínica Médica**: Especialidades, convênios, link de agenda.\n` +
        `🤖 **Genérico**: Agente inteligente customizável para qualquer negócio.`;

    const buttons = [
        [Markup.button.callback("🏠 Imobiliária", `wa_ai_set_niche_${id}_real_estate`)],
        [Markup.button.callback("🏥 Clínica Médica", `wa_ai_set_niche_${id}_medical_clinic`)],
        [Markup.button.callback("🤖 Agente Genérico", `wa_ai_set_niche_${id}_generic`)],
        [Markup.button.callback("🔙 Voltar", `wa_ai_menu_${id}`)]
    ];
    await ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^wa_ai_set_niche_(.+)_(real_estate|medical_clinic|generic)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    if (!await checkOwnership(ctx, instId)) return;
    const niche = ctx.match[2];
    log(`[NICHE] Usuário tentou setar nicho: ${niche} para instância: ${instId}`);

    const session = await getSession(ctx.chat.id);
    const inst = session.whatsapp.instances.find(i => i.id === instId);

    if (inst) {
        inst.niche = niche;
        // Inicializa dados padrão se não existirem
        if (!inst.niche_data) inst.niche_data = {};

        await syncSession(ctx, session);
        ctx.answerCbQuery(`✅ Modelo ${niche} ativado!`).catch(() => { });

        const msg = `✅ *Perfil ${niche.toUpperCase()} Ativado!*\n\n` +
            `A IA agora seguirá as regras automáticas deste nicho.\n\n` +
            `👉 *O que fazer agora?* Você precisa configurar as informações da sua empresa para que a IA saiba o que responder.`;

        const btn = niche === 'real_estate' ? "⚙️ Configurar Imobiliária" : "⚙️ Configurar Perfil";

        await ctx.editMessageText(msg, {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
                [Markup.button.callback(btn, `wa_ai_wizard_re_${instId}`)],
                [Markup.button.callback("⚙️ Resetar Perfil", `wa_ai_set_niche_${instId}_${niche}`)],
                [Markup.button.callback("🔙 Voltar", `wa_ai_menu_${instId}`)]
            ])
        });
    }
});

bot.action(/^wa_ai_re_style_(.+)_(amigavel|formal|direto|descontraido)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    if (!await checkOwnership(ctx, instId)) return;
    const styleVal = ctx.match[2];
    const session = await getSession(ctx.chat.id);
    const inst = session.whatsapp.instances.find(i => i.id === instId);

    if (inst) {
        const styleMap = {
            'amigavel': 'Amigável e com Emojis',
            'formal': 'Formal e Profissional',
            'direto': 'Direto e Persuasivo',
            'descontraido': 'Descontraído'
        };
        inst.niche_data.style = styleMap[styleVal];
        await syncSession(ctx, session);

        const tones = [
            [Markup.button.callback("🤝 Acolhedora", `wa_ai_re_tone_${instId}_acolhedora`)],
            [Markup.button.callback("💰 Vendedora", `wa_ai_re_tone_${instId}_vendedora`)],
            [Markup.button.callback("🧠 Consultiva", `wa_ai_re_tone_${instId}_consultiva`)]
        ];
        ctx.editMessageText("🗣️ *Passo 9/9: Tom de Voz*\n\nComo a IA deve se posicionar?", { parse_mode: "Markdown", ...Markup.inlineKeyboard(tones) });
    }
});

bot.action(/^wa_ai_re_tone_(.+)_(acolhedora|vendedora|consultiva)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    if (!await checkOwnership(ctx, instId)) return;
    const toneVal = ctx.match[2];
    const session = await getSession(ctx.chat.id);
    const inst = session.whatsapp.instances.find(i => i.id === instId);

    if (inst) {
        const toneMap = {
            'acolhedora': 'Acolhedora',
            'vendedora': 'Vendedora',
            'consultiva': 'Consultiva'
        };
        inst.niche_data.tone = toneMap[toneVal];
        await syncSession(ctx, session);

        await ctx.editMessageText("🎉 *Configuração Concluída!*\n\nSua IA de Imobiliária foi calibrada com sucesso.\n\n" +
            "A partir de agora, ela usará todas as informações fornecidas (Nome, Regras, Tom) para atender seus clientes de forma profissional.", {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar ao Menu", `wa_ai_menu_${instId}`)]])
        });
    }
});

bot.action(/^wa_ai_wizard_re_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    await triggerRealEstateWizard(ctx, id, 1);
});

bot.action(/^wa_ai_wizard_mc_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    await triggerMedicalWizard(ctx, id, 1);
});

bot.action(/^wa_ai_wizard_gn_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    await triggerGenericWizard(ctx, id, 1);
});

// Handler genérico para "Manter Atual" (Regex corrigida para evitar quebra em campos com _)
bot.action(/^wa_ai_keep_(re|mc|gn)_([^_]+(?:_[^_]+)*)_([^_]+_[^_]+_[^_]+)$/, async (ctx) => {
    safeAnswer(ctx);
    const niche = ctx.match[1];
    const field = ctx.match[2];
    const instId = ctx.match[3];

    // Mapeamento de ordem para avançar
    const order = {
        're': ['company_name', 'greeting', 'address', 'products', 'funnel', 'bio', 'rules'],
        'mc': ['company_name', 'specialties', 'plans', 'booking_link', 'address', 'greeting', 'bio'],
        'gn': ['company_name', 'goal', 'products', 'rules', 'greeting', 'bio']
    };

    const currentIdx = order[niche].indexOf(field);
    const nextStep = currentIdx + 2; // 1-indexed e próximo

    if (niche === 're') await triggerRealEstateWizard(ctx, instId, nextStep);
    else if (niche === 'mc') await triggerMedicalWizard(ctx, instId, nextStep);
    else if (niche === 'gn') await triggerGenericWizard(ctx, instId, nextStep);
});

bot.action(/^wa_ai_keep_fu_(hours|max|msgs)_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[2];
    if (!await checkOwnership(ctx, id)) return;
    const session = await getSession(ctx.chat.id);
    session.stage = "READY";
    await syncSession(ctx, session);
    await renderFollowupMenu(ctx, id);
});

bot.action(/^wa_ai_keep_resume_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const session = await getSession(ctx.chat.id);
    session.stage = "READY";
    await syncSession(ctx, session);
    await renderAiMenu(ctx, id);
});

bot.action(/^wa_ai_wizard_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const session = await getSession(ctx.chat.id);
    session.stage = `WA_WIZ_NAME_${id}`;
    await syncSession(ctx, session);
    ctx.reply("🧙‍♂️ *Mágico de Prompt: Passo 1/3*\n\nQual o **NOME** da sua empresa ou do seu negócio?", { parse_mode: "Markdown" });
});

bot.action(/^wa_ai_sync_web_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    log(`[SYNC] Iniciando sincronização manual para ${id}...`);
    await ensureWebhookSet(id);
    ctx.answerCbQuery("✅ Webhook sincronizado com sucesso!");
    try {
        await renderAiMenu(ctx, id);
    } catch (e) {
        if (!e.message.includes("message is not modified")) {
            log(`[SYNC ERR] ${e.message}`);
        }
    }
});

bot.action(/^wa_toggle_ai_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const session = await getSession(ctx.chat.id);
    const inst = session.whatsapp.instances.find(i => i.id === id);
    if (inst) {
        inst.ai_enabled = !inst.ai_enabled;
        await syncSession(ctx, session);
        ctx.answerCbQuery(`IA ${inst.ai_enabled ? "Ativada" : "Desativada"}!`);
        await renderAiMenu(ctx, id);
    }
});

bot.action(/^wa_ai_resume_time_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    if (!await checkOwnership(ctx, instId)) return;
    const session = await getSession(ctx.chat.id);
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    const current = inst.auto_resume_hours || 2;
    const msg = `⏱️ *Tempo de Reativação Automática*\n\n` +
        `Digite após quantas **horas** de silêncio (inatividade humana) a IA deve voltar a responder esse lead.\n\n` +
        `Exemplos:\n- \`0.5\` (30 minutos)\n- \`1\` (1 hora)\n- \`24\` (1 dia)\n\n` +
        (current ? `📌 *Valor Atual:* _${current}h_` : "");
    const buttons = current ? [[Markup.button.callback(`✅ Manter Atual`, `wa_ai_keep_resume_${instId}`)]] : [];

    ctx.reply(msg, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^wa_ai_resume_(.+)_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const tokenId = ctx.match[1];
    if (!await checkOwnership(ctx, tokenId)) return;
    const remoteJid = ctx.match[2];

    log(`[BOT] Retomando IA para ${remoteJid} na instância ${tokenId}`);
    await supabase.from("ai_leads_tracking")
        .update({ status: "RESPONDED", nudge_count: 0, last_interaction: new Date().toISOString() })
        .eq("chat_id", remoteJid).eq("instance_id", tokenId);

    ctx.editMessageText(`✅ *IA Retomada!*\nA partir da próxima mensagem, a IA responderá o cliente \`${remoteJid}\` novamente.`, { parse_mode: "Markdown" });
});

// --- Módulo de Rodízio de Corretores ---
async function renderBrokersMenu(ctx, instId) {
    const { data: brokers } = await supabase.from("real_estate_brokers").select("*");

    let text = `👤 *Gerenciamento de Corretores*\n\n` +
        `Cadastre os corretores que participarão do rodízio de leads para a instância \`${instId}\`.\n\n` +
        `📋 *Lista de Corretores:* \n`;

    if (!brokers || brokers.length === 0) {
        text += "_Nenhum corretor cadastrado._";
    } else {
        brokers.forEach((b, i) => {
            text += `${i + 1}. *${b.name}* (${b.phone}) ${b.status === 'active' ? '🟢' : '🔴'}\n`;
        });
    }

    const buttons = [
        [Markup.button.callback("➕ Adicionar Corretor", `wa_broker_add_${instId}`)],
        [Markup.button.callback("🗑️ Remover Corretor", `wa_broker_del_list_${instId}`)],
        [Markup.button.callback("🔙 Voltar", `manage_${instId}`)]
    ];

    await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
}

bot.action(/^wa_brokers_menu_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    await renderBrokersMenu(ctx, id);
});

bot.action(/^wa_broker_add_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const session = await getSession(ctx.chat.id);
    session.stage = `WA_BROKER_WAIT_NAME_${id}`;
    await syncSession(ctx, session);
    ctx.reply("📝 Digite o **NOME** do corretor:");
});

bot.action(/^wa_broker_del_list_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const { data: brokers } = await supabase.from("real_estate_brokers").select("*");

    if (!brokers || brokers.length === 0) return ctx.answerCbQuery("❌ Nenhum corretor para remover.");

    const buttons = brokers.map(b => [Markup.button.callback(`❌ ${b.name}`, `wa_broker_confirm_del_${id}_${b.id}`)]);
    buttons.push([Markup.button.callback("🔙 Voltar", `wa_brokers_menu_${id}`)]);

    ctx.editMessageText("Escolha o corretor para **remover**:", Markup.inlineKeyboard(buttons));
});

bot.action(/^wa_broker_confirm_del_(.+)_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    if (!await checkOwnership(ctx, instId)) return;
    const brokerId = ctx.match[2];
    await supabase.from("real_estate_brokers").delete().eq("id", brokerId);
    ctx.answerCbQuery("✅ Corretor removido!");
    await renderBrokersMenu(ctx, instId);
});

// Função para processar IA (Suporta Texto, Áudio/Whisper e Histórico/Memória)
async function handleAiSdr({ text, audioBase64, history = [], systemPrompt, chatId }) {
    try {
        let userMessage = text;

        // 1. Transcrever áudio se existir
        if (audioBase64 && !text) {
            log(`[AI SDR] Transcrevendo áudio para ${chatId}...`);
            const buffer = Buffer.from(audioBase64.split(",")[1] || audioBase64, 'base64');
            const tempPath = path.join(__dirname, `temp_audio_${chatId}.ogg`);
            fs.writeFileSync(tempPath, buffer);

            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(tempPath),
                model: "whisper-1",
            });

            userMessage = transcription.text;
            fs.unlinkSync(tempPath);
            log(`[AI SDR] Áudio transcrito: "${userMessage}"`);
        }

        if (!userMessage && history.length === 0) return null;

        // 2. Formatar Histórico para context (Cronologia Correta)
        const messages = [{ role: "system", content: systemPrompt }];

        // Adicionar histórico (últimas 15 msgs) ordenado cronologicamente (Antigo -> Novo)
        const sortedHistory = [...history].reverse().slice(-15);

        sortedHistory.forEach(msg => {
            // Identificação robusta do papel (Removido sender_jid === chatId que causava bug)
            const isMe = msg.from_me === true || msg.FromMe === true ||
                (msg.sender_jid && msg.sender_jid.includes("me")) ||
                (msg.Info?.FromMe === true);
            const role = isMe ? "assistant" : "user";

            // Extração robusta de conteúdo do histórico
            const content = msg.text_content || msg.Body ||
                msg.Message?.Conversation ||
                msg.Message?.conversation ||
                msg.Message?.extendedTextMessage?.text ||
                msg.Message?.imageMessage?.caption ||
                msg.Message?.videoMessage?.caption ||
                msg.Message?.documentMessage?.caption || "";

            if (content && typeof content === 'string' && content.trim().length > 0) {
                // log(`[AI DEBUG] Role: ${role} | Content: ${content.substring(0, 50)}...`);
                messages.push({ role, content: content.trim() });
            }
        });

        // Adicionar mensagem atual se houver
        if (userMessage) messages.push({ role: "user", content: userMessage });

        // 3. Gerar resposta humanizada
        const response = await openai.chat.completions.create({
            model: DEFAULT_MODEL,
            messages: messages,
            temperature: 0.8,
            max_tokens: 200
        });

        return response.choices[0].message.content;
    } catch (e) {
        log(`[ERR AI SDR] ${e.message}`);
        return null;
    }
}

// --- Módulo de Distribuição de Leads (Rodízio Round-Robin) ---
async function distributeLead(tgChatId, leadJid, instId, leadName, summary) {
    try {
        log(`[RODÍZIO] Buscando corretores para ${tgChatId}...`);
        const { data: brokers, error } = await supabase
            .from("real_estate_brokers")
            .select("*")
            .eq("tg_chat_id", String(tgChatId))
            .eq("status", "active");

        if (error || !brokers || brokers.length === 0) {
            log(`[RODÍZIO] Nenhum corretor ativo encontrado para ${tgChatId}`);
            return;
        }

        const session = await getSession(tgChatId);
        let nextIndex = session.last_broker_index || 0;

        if (nextIndex >= brokers.length) nextIndex = 0;

        const broker = brokers[nextIndex];
        log(`[RODÍZIO] Encaminhando lead ${leadName} para ${broker.name} (${broker.phone})`);

        const msg = `🚀 *NOVO LEAD QUALIFICADO!* \n\n` +
            `👤 *Cliente:* ${leadName}\n` +
            `📱 *WhatsApp:* ${leadJid.split('@')[0]}\n\n` +
            `📝 *Resumo da IA:* \n${summary}\n\n` +
            `🔔 *Instância:* ${instId}\n` +
            `👉 *Ação:* Esse lead foi atribuído a VOCÊ e a IA foi pausada. Assuma o papo agora!`;

        await callWuzapi("/chat/send/text", "POST", { Phone: broker.phone, Body: msg }, instId);

        // Atualizar índice para o próximo (Corretor vai pro fim da fila)
        session.last_broker_index = (nextIndex + 1) % brokers.length;
        await saveSession(tgChatId, session);

        bot.telegram.sendMessage(tgChatId, `✅ *Rodízio Inteligente:* Lead **${leadName}** encaminhado para o corretor **${broker.name}**. (Próximo da fila atualizado)`);
    } catch (e) {
        log(`[ERR RODÍZIO] ${e.message}`);
    }
}

// --- Worker de Reativação Automática da IA ---
async function checkAutoResume() {
    try {
        // Buscar leads em atendimento humano
        const { data: leads, error } = await supabase
            .from("ai_leads_tracking")
            .select("*")
            .eq("status", "HUMAN_ACTIVE");

        if (error || !leads) return;

        for (const lead of leads) {
            const parts = lead.instance_id.split("_");
            if (parts.length < 2) continue;
            const tgChatId = parts[1];

            const session = await getSession(tgChatId);
            const inst = session.whatsapp.instances.find(i => i.id === lead.instance_id);

            if (!inst) continue;

            // Por padrão 2 horas se não configurado
            const resumeHours = inst.auto_resume_hours || 2;
            const now = new Date();
            const lastInt = new Date(lead.last_interaction);
            const diffMs = now - lastInt;
            const diffHours = diffMs / (1000 * 60 * 60);

            if (diffHours >= resumeHours) {
                log(`[AUTO-RESUME] Reativando IA para ${lead.chat_id} (Inativo por ${diffHours.toFixed(1)}h)`);
                await supabase.from("ai_leads_tracking").update({ status: "RESPONDED" })
                    .eq("id", lead.id);

                bot.telegram.sendMessage(tgChatId, `🤖 *IA Reativada:* O lead \`${lead.chat_id}\` estava em silêncio por ${resumeHours}h. A IA assumiu o atendimento novamente.`, {
                    parse_mode: "Markdown"
                });
            }
        }
    } catch (e) {
        log(`[ERR AUTO-RESUME] ${e.message}`);
    }
}

bot.action(/^wa_logout_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const res = await callWuzapi(`/session/logout`, "POST", null, id);
    ctx.reply(res.success ? "✅ Logout ok." : "❌ Falha no logout.");
});

bot.action(/^wa_del_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;

    // 1. Tentar descobrir o ID interno real do WUZAPI
    const stats = await callWuzapi(`/session/status`, "GET", null, id);
    let internalId = id;
    if (stats.success && stats.data && stats.data.id) {
        internalId = stats.data.id;
    }

    // 2. Tentativa de deleção Admin
    let res = await callWuzapi(`/admin/users/${internalId}/full`, "DELETE");

    // 3. Fallback: Se falhar e tiver um token diferente, tenta pelo token
    if (!res.success && internalId !== id) {
        res = await callWuzapi(`/admin/users/${id}/full`, "DELETE");
    }

    // 4. Fallback: Sem /full
    if (!res.success) {
        res = await callWuzapi(`/admin/users/${internalId}`, "DELETE");
    }

    // Se a API confirmou OU se ela diz que o usuário não existe (já deletado/ID errado)
    if (res.success || res.error === "user not found" || res.details === "user not found") {
        const session = await getSession(ctx.chat.id);
        session.whatsapp.instances = session.whatsapp.instances.filter(i => i.id !== id);
        await syncSession(ctx, session);
        ctx.reply("🗑️ Instância removida com sucesso!");
    } else {
        log(`[DEL FAIL] ${id} | Internal: ${internalId} | Res: ${JSON.stringify(res)}`);
        ctx.reply(`❌ Ocorreu um erro na API Wuzapi (${res.error || "Inconhecido"}).\n\nCaso a instância já tenha sido removida manualmente do painel, você pode forçar a remoção da lista do bot:`, {
            ...Markup.inlineKeyboard([[Markup.button.callback("⚠️ Forçar Remoção Local", `wa_force_del_${id}`)]])
        });
    }
});

bot.action(/^wa_force_del_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    if (!await checkOwnership(ctx, id)) return;
    const session = await getSession(ctx.chat.id);
    session.whatsapp.instances = session.whatsapp.instances.filter(i => i.id !== id);
    await syncSession(ctx, session);
    ctx.editMessageText("✅ Instância removida da sua lista local.");
});

bot.action(/^wa_del_web_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const res = await callWuzapi("/webhook", "DELETE", null, id);
    if (res.success) {
        ctx.answerCbQuery("✅ Webhook removido!");
        await renderWebhookMenu(ctx, id);
    } else {
        ctx.answerCbQuery("❌ Erro ao remover webhook.");
    }
});

bot.action("gen_pix_mensal", async (ctx) => {
    safeAnswer(ctx);
    ctx.reply("⏳ Gerando Pix...");
    const res = await createSyncPayPix(ctx.chat.id, getSystemConfig().planPrice, ctx.from.first_name);
    if (res.pix_code) {
        const qr = await QRCode.toBuffer(res.pix_code);
        ctx.replyWithPhoto({ source: qr }, { caption: `💎 *Plano Pro*\n\nPIX:\n\`${res.pix_code}\``, parse_mode: "Markdown" });
    } else { ctx.reply("❌ Erro ao gerar pagamento."); }
});

bot.on("text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const session = await getSession(ctx.chat.id);

    // Função de limpeza de mensagens para manter o chat limpo
    const cleanup = async () => {
        try { if (session.last_menu_id) await ctx.telegram.deleteMessage(ctx.chat.id, session.last_menu_id); } catch (e) { }
        try { await ctx.deleteMessage(); } catch (e) { }
        session.last_menu_id = null;
    };

    // --- ADMIN STAGES ---
    if (session.stage && session.stage.startsWith("ADMIN_WAIT_")) {
        const config = await getSystemConfig();
        if (!isAdmin(ctx.chat.id, config)) return;

        if (session.stage === "ADMIN_WAIT_BROADCAST") {
            const msg = ctx.message.text;
            const { data: allSessions } = await supabase.from('bot_sessions').select('chat_id');
            let count = 0;
            ctx.reply("📢 Enviando broadcast... isso pode levar alguns segundos.");
            for (const s of (allSessions || [])) {
                try {
                    await bot.telegram.sendMessage(s.chat_id, `📢 *Mensagem do Admin:*\n\n${msg}`, { parse_mode: "Markdown" });
                    count++;
                    await new Promise(r => setTimeout(r, 100)); // Rate limit simples
                } catch (e) { }
            }
            ctx.reply(`✅ Broadcast enviado para **${count}** usuários.`);
            session.stage = "READY";
            await syncSession(ctx, session);
            return renderAdminPanel(ctx);
        }

        if (session.stage === "ADMIN_WAIT_PRICE") {
            const price = parseFloat(ctx.message.text.replace(",", "."));
            if (isNaN(price)) return ctx.reply("❌ Valor inválido (ex: 49.90).");
            config.planPrice = price;
            await saveSystemConfig(config);
            ctx.reply(`✅ Preço atualizado para **R$ ${price.toFixed(2)}**.`);
            session.stage = "READY";
            await syncSession(ctx, session);
            return renderAdminPanel(ctx);
        }

        if (session.stage === "ADMIN_WAIT_LIMIT_VIP") {
            const insts = parseInt(ctx.message.text.trim());
            if (isNaN(insts)) return ctx.reply("❌ Digite um número válido.");

            config.limits.vip.instances = insts;
            await saveSystemConfig(config);
            ctx.reply(`✅ Limite de instâncias VIP atualizado para **${insts}**.`);
            session.stage = "READY";
            await syncSession(ctx, session);
            return renderAdminPanel(ctx);
        }
        await syncSession(ctx, session);
        return renderAdminPanel(ctx);
    }

    if (session.stage === "ADMIN_WAIT_VIP_MANUAL") {
        const targetId = ctx.message.text.trim();
        const s = await getSession(targetId);
        s.isVip = !s.isVip;
        if (s.isVip) {
            const exp = new Date(); exp.setDate(exp.getDate() + 30);
            s.subscriptionExpiry = exp.toISOString();
        }
        await saveSession(targetId, s);
        ctx.reply(`✅ Usuário \`${targetId}\` agora é: **${s.isVip ? "VIP" : "FREE"}**`);
        session.stage = "READY";
        await syncSession(ctx, session);
        return renderAdminPanel(ctx);
    }
}

    if (session.stage === "WA_WAITING_NAME") {
    await cleanup();
    const config = await getSystemConfig();
    const isVip = await checkVip(ctx.chat.id);
    const limit = config.limits.vip.instances;
    const current = session.whatsapp.instances.length;

    if (current >= limit) {
        return ctx.reply(`⚠️ *Limite de Instâncias Atingido!*\n\nSeu plano permite apenas **${limit}** instâncias.\n\nFale com o suporte ou use /admin se for o dono.`, {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("💎 Ver Planos", "cmd_planos_menu")]])
        });
    }

    const name = ctx.message.text.trim().substring(0, 30);
    const id = `wa_${ctx.chat.id}_${Date.now().toString().slice(-4)}`;
    // WUZAPI: create user (admin)
    const res = await callWuzapi("/admin/users", "POST", { name: id, token: id });

    if (res.success) {
        session.whatsapp.instances.push({ id, name, status: "CONNECTING" });
        session.stage = "READY";
        await syncSession(ctx, session);

        // Auto-configurar webhook próprio para notificações de conexão
        await callWuzapi("/webhook", "POST", { webhook: WEBHOOK_URL, events: ["All"] }, id);

        const sent = await ctx.reply(`✅ Instância *${name}* criada!`, {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
                [Markup.button.callback("📷 QR Code", `wa_qr_${id}`)],
                [Markup.button.callback("🔢 Conectar por Código", `wa_pair_${id}`)],
                [Markup.button.callback("📱 Minhas Instâncias", "cmd_instancias")]
            ])
        });
        session.last_ui_id = sent.message_id;
        await syncSession(ctx, session);
    } else {
        ctx.reply(`❌ Erro ao criar na API: ${res.error || "Tente novamente mais tarde"}`);
    }

} else if (session.stage && session.stage.startsWith("WA_WIZ_NAME_")) {
    await cleanup();
    const instId = session.stage.replace("WA_WIZ_NAME_", "");
    if (!await checkOwnership(ctx, instId)) return;
    session.wiz_data = { name: ctx.message.text.trim() };
    session.stage = `WA_WIZ_PRODUCT_${instId}`;
    await syncSession(ctx, session);
    const sent = await ctx.reply("📦 *Passo 2/3: Produto/Serviço*\n\nLegal! Agora me conte: o que você vende ou qual serviço sua empresa oferece?", { parse_mode: "Markdown" });
    session.last_ui_id = sent.message_id;
    await syncSession(ctx, session);

} else if (session.stage && session.stage.startsWith("WA_WIZ_PRODUCT_")) {
    await cleanup();
    const instId = session.stage.replace("WA_WIZ_PRODUCT_", "");
    if (!await checkOwnership(ctx, instId)) return;
    session.wiz_data.product = ctx.message.text.trim();
    session.stage = `WA_WIZ_GOAL_${instId}`;
    await syncSession(ctx, session);
    const sent = await ctx.reply("🎯 *Passo 3/3: Objetivo*\n\nQual o objetivo principal deste WhatsApp? (Ex: Tirar dúvidas, agendar consultoria, vender produtos, suporte técnico)", { parse_mode: "Markdown" });
    session.last_ui_id = sent.message_id;
    await syncSession(ctx, session);

} else if (session.stage && session.stage.startsWith("WA_WIZ_GOAL_")) {
    await cleanup();
    const instId = session.stage.replace("WA_WIZ_GOAL_", "");
    if (!await checkOwnership(ctx, instId)) return;
    const goal = ctx.message.text.trim();
    const { name, product } = session.wiz_data;

    const generatedPrompt = `Você é o assistente virtual da empresa ${name}. ` +
        `Seu foco principal é ${product}. ` +
        `Seu objetivo no atendimento é ${goal}. ` +
        `Sempre use um tom profissional, amigável e prestativo. ` +
        `Responda de forma clara e objetiva.`;

    // Salvar na instância
    const inst = session.whatsapp.instances.find(i => i.id === instId);
    if (inst) {
        inst.ai_prompt = generatedPrompt;
        inst.ai_enabled = true; // Ativar por padrão ao usar o mágico
        await syncSession(ctx, session);
    }
    try { ctx.deleteMessage(); } catch (e) { } // Limpar resposta do usuário
    session.stage = "READY";
    delete session.wiz_data;
    await syncSession(ctx, session);
    ctx.reply("✨ *Configuração Concluída!*\n\nSeu prompt foi gerado e a IA foi ativada automaticamente.\n\n" +
        `📝 *Prompt Gerado:* \n\`${generatedPrompt}\``, { parse_mode: "Markdown" });
    await renderAiMenu(ctx, instId);
} else if (session.stage && session.stage.startsWith("WA_BROKER_WAIT_NAME_")) {
    const instId = session.stage.replace("WA_BROKER_WAIT_NAME_", "");
    if (!await checkOwnership(ctx, instId)) return;
    // Limite de corretores removido (Liberado)
    const name = ctx.message.text.trim();
    session.tempBroker = { name };
    session.stage = `WA_BROKER_WAIT_PHONE_${instId}`;
    await syncSession(ctx, session);
    return ctx.reply(`Ótimo! Agora digite o **WHATSAPP** do corretor ${name} (ex: 5511999999999):`);

} else if (session.stage && session.stage.startsWith("WA_BROKER_WAIT_PHONE_")) {
    const instId = session.stage.replace("WA_BROKER_WAIT_PHONE_", "");
    if (!await checkOwnership(ctx, instId)) return;
    let phone = ctx.message.text.trim().replace(/\D/g, "");
    if (!phone.includes("@")) phone += "@s.whatsapp.net";

    const { error } = await supabase.from("real_estate_brokers").insert({
        name: session.tempBroker.name,
        phone: phone,
        tg_chat_id: String(ctx.chat.id)
    });

    if (error) {
        ctx.reply("❌ Erro ao salvar corretor.");
    } else {
        ctx.reply(`✅ Corretor **${session.tempBroker.name}** cadastrado!`);
        session.stage = "READY";
        delete session.tempBroker;
        await syncSession(ctx, session);
        await renderBrokersMenu(ctx, instId);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_RE_COMPANY_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_RE_COMPANY_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.company_name = ctx.message.text.trim();
        await triggerRealEstateWizard(ctx, instId, 2);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_RE_GREETING_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_RE_GREETING_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.greeting = ctx.message.text.trim();
        await triggerRealEstateWizard(ctx, instId, 3);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_RE_ADDRESS_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_RE_ADDRESS_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.address = ctx.message.text.trim();
        await triggerRealEstateWizard(ctx, instId, 4);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_RE_PRODUCT_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_RE_PRODUCT_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.products = ctx.message.text.trim();
        await triggerRealEstateWizard(ctx, instId, 5);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_RE_FUNNEL_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_RE_FUNNEL_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.funnel = ctx.message.text.trim();
        await triggerRealEstateWizard(ctx, instId, 6);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_RE_BIO_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_RE_BIO_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.bio = ctx.message.text.trim();
        await triggerRealEstateWizard(ctx, instId, 7);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_MC_COMPANY_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_MC_COMPANY_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.company_name = ctx.message.text.trim();
        await triggerMedicalWizard(ctx, instId, 2);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_MC_SPECIALTIES_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_MC_SPECIALTIES_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.specialties = ctx.message.text.trim();
        await triggerMedicalWizard(ctx, instId, 3);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_MC_PLANS_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_MC_PLANS_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.plans = ctx.message.text.trim();
        await triggerMedicalWizard(ctx, instId, 4);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_MC_BOOKING_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_MC_BOOKING_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.booking_link = ctx.message.text.trim();
        await triggerMedicalWizard(ctx, instId, 5);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_MC_ADDRESS_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_MC_ADDRESS_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.address = ctx.message.text.trim();
        await triggerMedicalWizard(ctx, instId, 6);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_MC_GREETING_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_MC_GREETING_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.greeting = ctx.message.text.trim();
        await triggerMedicalWizard(ctx, instId, 7);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_MC_BIO_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_MC_BIO_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.bio = ctx.message.text.trim();
        await triggerMedicalWizard(ctx, instId, 8);
    }

    // --- GENERIC WIZARD ---
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_GN_COMPANY_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_GN_COMPANY_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.company_name = ctx.message.text.trim();
        await triggerGenericWizard(ctx, instId, 2);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_GN_GOAL_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_GN_GOAL_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.goal = ctx.message.text.trim();
        await triggerGenericWizard(ctx, instId, 3);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_GN_PRODUCTS_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_GN_PRODUCTS_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.products = ctx.message.text.trim();
        await triggerGenericWizard(ctx, instId, 4);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_GN_RULES_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_GN_RULES_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.rules = ctx.message.text.trim();
        await triggerGenericWizard(ctx, instId, 5);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_GN_GREETING_")) {
    const instId = session.stage.replace("WA_AI_CONF_GN_GREETING_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.greeting = ctx.message.text.trim();
        await triggerGenericWizard(ctx, instId, 6);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_CONF_GN_BIO_")) {
    const instId = session.stage.replace("WA_AI_CONF_GN_BIO_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.bio = ctx.message.text.trim();
        await triggerGenericWizard(ctx, instId, 7);
    }

} else if (session.stage && session.stage.startsWith("WA_AI_CONF_RE_RULES_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_CONF_RE_RULES_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    if (inst) {
        inst.niche_data.rules = ctx.message.text.trim();
        session.stage = "READY";
        await syncSession(ctx, session);

        const styles = [
            [Markup.button.callback("😊 Amigável e com Emojis", `wa_ai_re_style_${instId}_amigavel`)],
            [Markup.button.callback("💼 Formal e Profissional", `wa_ai_re_style_${instId}_formal`)],
            [Markup.button.callback("🎯 Direto e Persuasivo", `wa_ai_re_style_${instId}_direto`)],
            [Markup.button.callback("😎 Descontraído", `wa_ai_re_style_${instId}_descontraido`)]
        ];
        const sent = await ctx.reply("🎭 *Passo 8/9: Estilo de Conversa*\n\nEscolha como a IA deve falar:", Markup.inlineKeyboard(styles));
        session.last_ui_id = sent.message_id;
        await syncSession(ctx, session);
    }
} else if (session.stage && session.stage.startsWith("WA_AI_RESUME_TIME_VAL_")) {
    await cleanup();
    const instId = session.stage.replace("WA_AI_RESUME_TIME_VAL_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    const val = parseFloat(ctx.message.text.trim().replace(",", "."));
    if (isNaN(val) || val < 0.1) return ctx.reply("❌ Valor inválido. Use um número (ex: 0.5 para 30 min, 2 para 2 horas).");

    inst.auto_resume_hours = val;
    await syncSession(ctx, session);
    const sent = await ctx.reply(`✅ *Tempo Atualizado:* A IA voltará a atender após **${val}h** de silêncio humano.`);
    session.last_ui_id = sent.message_id;
    await syncSession(ctx, session);
    await renderAiMenu(ctx, instId);
    session.stage = "READY";
    await syncSession(ctx, session);
    return;

} else if (session.stage && session.stage.startsWith("WA_WAITING_MASS_CONTACTS_")) {
    await cleanup();
    const instId = session.stage.replace("WA_WAITING_MASS_CONTACTS_", "");
    if (!await checkOwnership(ctx, instId)) return;

    const lines = ctx.message.text.split("\n").map(n => n.trim()).filter(n => n.length > 5);
    const contacts = lines.map(line => {
        if (line.includes(";")) {
            const [name, phone] = line.split(";").map(p => p.trim());
            return { name, phone: phone.replace(/\D/g, "") };
        }
        return { name: null, phone: line.replace(/\D/g, "") };
    }).filter(c => c.phone.length >= 8);

    if (contacts.length === 0) return ctx.reply("❌ Nenhum número válido encontrado.\n\nEnvie um por linha no formato `Telefone` ou `Nome;Telefone`.");

    session.mass_contacts = contacts;
    session.stage = `WA_WAITING_MASS_MSG_${instId}`;
    await syncSession(ctx, session);

    const prompt = `✅ *${contacts.length} contatos recebidos.*\n\n` +
        `Agora, envie o **conteúdo** que deseja disparar. Você pode enviar:\n\n` +
        `📝 *Apenas Texto:* Digite e envie normalmente.\n` +
        `🖼️ *Foto / Vídeo / Documento:* Envie o arquivo. A legenda será usada como a mensagem.\n` +
        `🎙️ *Áudio / Voz:* Envie o arquivo de áudio ou grave uma nota de voz.\n\n` +
        `💡 *Anti-Spam:* Envie várias variações separadas por \`;;;\` (na legenda ou no texto).\n` +
        `💡 *Personalização:* Use \`{{nome}}\` para o nome do contato.\n\n` +
        `*Exemplo:* \`Oi {{nome}}!;;;Olá, como vai?;;;Fala {{nome}}!\``;

    const sent = await ctx.reply(prompt, { parse_mode: "Markdown" });
    session.last_ui_id = sent.message_id;
    await syncSession(ctx, session);

} else if (session.stage && session.stage.startsWith("WA_WAITING_MASS_MSG_")) {
    const instId = session.stage.replace("WA_WAITING_MASS_MSG_", "");
    if (!await checkOwnership(ctx, instId)) return;

    const rawMsg = ctx.message.text || "";
    const variations = rawMsg.split(";;;").map(v => v.trim()).filter(v => v.length > 0);

    session.mass_msgs = variations.length > 0 ? variations : [rawMsg];
    session.mass_media_type = 'text';
    session.stage = `WA_WAITING_MASS_DELAY_${instId}`;

    // Limpar prompt anterior e msg enviada
    if (session.last_ui_id) try { await ctx.telegram.deleteMessage(ctx.chat.id, session.last_ui_id); } catch (e) { }
    try { await ctx.deleteMessage(); } catch (e) { }

    const sent = await ctx.reply(`📝 ${session.mass_msgs.length} variações de mensagem salvas.\n\nAgora, defina o **intervalo de tempo** (delay) em segundos no formato \`MÍN-MÁX\`.\n\nExemplo: \`10-30\`.`);
    session.last_ui_id = sent.message_id;
    await syncSession(ctx, session);

} else if (session.stage && session.stage.startsWith("WA_WAITING_MASS_DELAY_")) {
    const instId = session.stage.replace("WA_WAITING_MASS_DELAY_", "");
    if (!await checkOwnership(ctx, instId)) return;
    const parts = ctx.message.text.split("-");
    const min = parseInt(parts[0]);
    const max = parseInt(parts[1]);

    if (isNaN(min) || isNaN(max) || min < 1) {
        return ctx.reply("❌ Formato inválido. Use algo como `10-30`.");
    }

    session.temp_mass_min = min;
    session.temp_mass_max = max;
    await syncSession(ctx, session);

    ctx.reply("🕒 *Quando deseja realizar o disparo?*", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
            [Markup.button.callback("🚀 Enviar Agora", `wa_mass_now_${instId}`)],
            [Markup.button.callback("📅 Agendar para depois", `wa_mass_sched_${instId}`)]
        ])
    });

} else if (session.stage && session.stage.startsWith("WA_WAITING_MASS_SCHEDULE_")) {
    const instId = session.stage.replace("WA_WAITING_MASS_SCHEDULE_", "");
    if (!await checkOwnership(ctx, instId)) return;
    const dateStr = ctx.message.text.trim();

    // Regex simples para DD/MM/AAAA HH:MM
    const reg = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
    const match = dateStr.match(reg);

    if (!match) return ctx.reply("❌ Formato inválido. Use `DD/MM/AAAA HH:MM`.");

    const [_, d, m, y, h, min] = match;
    const scheduledFor = new Date(y, m - 1, d, h, min);

    const now = new Date();
    const serverTimeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const serverDateStr = now.toLocaleDateString('pt-BR');

    // Buffer de 4 horas para lidar com disparidade UTC (Servidor) vs BRT (Usuário)
    const bufferNow = new Date();
    bufferNow.setHours(bufferNow.getHours() - 4);

    if (isNaN(scheduledFor.getTime()) || scheduledFor < bufferNow) {
        return ctx.reply(`❌ *Data no passado!*\n\nHora no Servidor: \`${serverDateStr} ${serverTimeStr}\`\nSua entrada: \`${dateStr}\`\n\nPor favor, envie um horário futuro baseado no relógio do servidor acima.`, { parse_mode: "Markdown" });
    }

    const campaignData = {
        contacts: session.mass_contacts,
        messages: session.mass_msgs,
        message: session.mass_msgs[0],
        mediaType: session.mass_media_type,
        mediaUrl: session.mass_media_url,
        mediaData: session.mass_media_data,
        fileName: session.mass_file_name,
        minDelay: session.temp_mass_min,
        maxDelay: session.temp_mass_max
    };

    const { error } = await supabase
        .from('scheduled_campaigns')
        .insert({
            chat_id: String(ctx.chat.id),
            inst_id: instId,
            scheduled_for: scheduledFor.toISOString(),
            campaign_data: campaignData,
            status: 'PENDING'
        });

    if (error) {
        log(`[SCHED ERR] ${error.message}`);
        return ctx.reply("❌ Erro ao salvar agendamento no banco.");
    }

    session.stage = "READY";
    await syncSession(ctx, session);

    ctx.reply(`✅ *Disparo Agendado!*\n\n📅 Data: \`${dateStr}\`\n🚀 Instância: \`${instId}\`\n\nO sistema iniciará o envio automaticamente no horário marcado.`);

} else if (session.stage && session.stage.startsWith("WA_WAITING_PAIR_PHONE_")) {
    const instId = session.stage.replace("WA_WAITING_PAIR_PHONE_", "");
    if (!await checkOwnership(ctx, instId)) return;
    const rawPhone = ctx.message.text.trim();
    const phone = rawPhone.replace(/\D/g, ""); // Limpa qualquer caractere não numérico

    if (phone.length < 10) {
        return ctx.reply("❌ Número inválido. Por favor, envie o número com DDD e DDI (ex: 5511999998888).");
    }

    session.stage = "READY";
    await syncSession(ctx, session);
    ctx.reply("⏳ Solicitando código e disparando notificação...");

    // Garante webhook para o aviso de sucesso chegar
    await ensureWebhookSet(instId);

    // Inicia polling proativo
    startConnectionPolling(ctx.chat.id, instId);

    // WUZAPI: connect first
    await callWuzapi("/session/connect", "POST", { Immediate: true }, instId);
    await new Promise(r => setTimeout(r, 1000));

    // Envia o número LIMPO para disparar o Push Notification
    const res = await callWuzapi("/session/pairphone", "POST", { Phone: phone }, instId);

    if (res.success && res.data && res.data.LinkingCode) {
        ctx.reply(`🔢 *Código de Pareamento:* \`${res.data.LinkingCode}\`\n\nConfira seu celular agora! Toque na notificação do WhatsApp e digite o código acima.`, {
            parse_mode: "Markdown"
        });
    } else {
        ctx.reply("❌ Erro ao gerar código. Tente usar o **QR Code**.");
    }

} else if (session.stage && session.stage.startsWith("WA_WAITING_WEBHOOK_URL_")) {
    const instId = session.stage.replace("WA_WAITING_WEBHOOK_URL_", "");
    if (!await checkOwnership(ctx, instId)) return;
    const url = ctx.message.text.trim();
    session.stage = "READY";
    await syncSession(ctx, session);

    // Obter o UUID interno via status de sessão para garantir persistência no Admin
    const statusRes = await callWuzapi("/session/status", "GET", null, instId);
    const uuid = statusRes?.data?.id;

    // 1. Configurar via endpoint padrão (Array)
    const robustPayload = {
        webhook: url,
        WebhookURL: url,
        events: ["All"],
        subscribe: ["All"],
        Active: true,
        active: true
    };
    const res = await callWuzapi("/webhook", "PUT", robustPayload, instId);

    if (uuid) {
        const adminPayload = {
            webhook: url,
            events: "All",
            subscribe: "All",
            Active: true
        };
        await callWuzapi(`/admin/users/${uuid}`, "PUT", adminPayload);
    }

    if (res.success) {
        ctx.reply("✅ URL do Webhook salva!");
        await renderWebhookMenu(ctx, instId);
    } else {
        ctx.reply("❌ Erro ao configurar a URL do webhook na API.");
    }
} else if (session.stage && session.stage.startsWith("WA_WAITING_AI_PROMPT_")) {
    const instId = session.stage.replace("WA_WAITING_AI_PROMPT_", "");
    const inst = await checkOwnership(ctx, instId);
    if (!inst) return;
    const prompt = ctx.message.text.trim();
    inst.ai_prompt = prompt;
    session.stage = "READY";
    await syncSession(ctx, session);
    ctx.reply("✅ *Instruções da IA salvas com sucesso!*", { parse_mode: "Markdown" });
    await renderAiMenu(ctx, instId);
} else if (session.stage && session.stage.startsWith("WA_WAITING_FU_HOURS_")) {
    const instId = session.stage.replace("WA_WAITING_FU_HOURS_", "");
    if (!await checkOwnership(ctx, instId)) return;
    const val = parseInt(ctx.message.text);
    if (isNaN(val)) return ctx.reply("⚠️ Por favor, envie um número válido.");

    const inst = session.whatsapp.instances.find(i => i.id === instId);
    if (inst) {
        inst.fu_hours = val;
        session.stage = "READY";
        await syncSession(ctx, session);
        ctx.reply(`✅ Tempo de espera definido para **${val} horas**.`);
        await renderFollowupMenu(ctx, instId);
    }
} else if (session.stage && session.stage.startsWith("WA_WAITING_FU_MAX_")) {
    const instId = session.stage.replace("WA_WAITING_FU_MAX_", "");
    if (!await checkOwnership(ctx, instId)) return;
    const val = parseInt(ctx.message.text);
    if (isNaN(val)) return ctx.reply("⚠️ Por favor, envie um número válido.");

    const inst = session.whatsapp.instances.find(i => i.id === instId);
    if (inst) {
        inst.fu_max = val;
        session.stage = "READY";
        await syncSession(ctx, session);
        ctx.reply(`✅ Máximo de lembretes definido para **${val}**.`);
        await renderFollowupMenu(ctx, instId);
    }
} else if (session.stage && session.stage.startsWith("WA_WAITING_FU_MSGS_")) {
    const instId = session.stage.replace("WA_WAITING_FU_MSGS_", "");
    if (!await checkOwnership(ctx, instId)) return;
    const msgs = ctx.message.text.split(";").map(m => m.trim()).filter(m => m.length > 0);
    if (msgs.length === 0) return ctx.reply("⚠️ Nenhuma mensagem válida detectada. Use `;` para separar.");

    const inst = session.whatsapp.instances.find(i => i.id === instId);
    if (inst) {
        inst.fu_msgs = msgs;
        session.stage = "READY";
        await syncSession(ctx, session);
        ctx.reply(`✅ **${msgs.length} mensagens** de follow-up salvas.`);
        await renderFollowupMenu(ctx, instId);
    }
}
});

// Helper para processar mídias de massa
async function handleMassMedia(ctx, type, fileId, caption, fileName, fileSize) {
    const session = await getSession(ctx.chat.id);
    if (!session.stage || !session.stage.startsWith("WA_WAITING_MASS_MSG_")) return;

    const instId = session.stage.replace("WA_WAITING_MASS_MSG_", "");
    if (!await checkOwnership(ctx, instId)) return;

    // Verificação de tamanho (Limite 20MB da API do Telegram Bot)
    const MAX_SIZE = 20 * 1024 * 1024;
    if (fileSize && fileSize > MAX_SIZE) {
        return ctx.reply(`⚠️ *Arquivo muito grande!*\n\nO seu arquivo tem ${(fileSize / (1024 * 1024)).toFixed(1)}MB.\n\nDevido a limitações do Telegram, só conseguimos processar arquivos de até **20MB**.\n\nPor favor, envie um arquivo menor ou um link de download.`, { parse_mode: "Markdown" });
    }

    // Limpar prompt anterior e mídia enviada
    if (session.last_ui_id) try { await ctx.telegram.deleteMessage(ctx.chat.id, session.last_ui_id); } catch (e) { }
    try { await ctx.deleteMessage(); } catch (e) { }

    const processingMsg = await ctx.reply(`⏳ Processando ${type}...`);

    try {
        const link = await ctx.telegram.getFileLink(fileId);
        const response = await fetch(link.href);
        const buffer = await response.buffer();

        let mimeType = '';
        if (type === 'photo') mimeType = 'image/jpeg';
        else if (type === 'video') mimeType = 'video/mp4';
        else if (type === 'audio') mimeType = 'audio/ogg';
        else if (type === 'document') mimeType = 'application/octet-stream';

        const base64Data = `data:${mimeType};base64,${buffer.toString('base64')}`;

        const variations = (caption || "").split(";;;").map(v => v.trim()).filter(v => v.length > 0);
        session.mass_msgs = variations.length > 0 ? variations : [""];
        session.mass_media_type = type;
        session.mass_media_data = base64Data;
        session.mass_msg = caption || ""; // Fallback
        session.mass_file_name = fileName || "arquivo";
        session.stage = `WA_WAITING_MASS_DELAY_${instId}`;

        // Deletar "Processando..." e enviar próximo passo
        try { await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch (e) { }

        const sent = await ctx.reply(`✅ ${type} recebido e processado!\n\nAgora, defina o **intervalo de tempo** (delay) em segundos no formato \`MÍN-MÁX\`.\n\nExemplo: \`10-30\``);
        session.last_ui_id = sent.message_id;
        await syncSession(ctx, session);
    } catch (e) {
        log(`[ERR MEDIA] ${e.message}`);
        ctx.reply("❌ Falha ao processar arquivo. Tente novamente.");
    }
}

bot.on("photo", ctx => handleMassMedia(ctx, 'photo', ctx.message.photo[ctx.message.photo.length - 1].file_id, ctx.message.caption, null, ctx.message.photo[ctx.message.photo.length - 1].file_size));
bot.on("video", ctx => handleMassMedia(ctx, 'video', ctx.message.video.file_id, ctx.message.caption, ctx.message.video.file_name, ctx.message.video.file_size));
bot.on("audio", ctx => handleMassMedia(ctx, 'audio', ctx.message.audio.file_id, ctx.message.caption, ctx.message.audio.file_name, ctx.message.audio.file_size));
bot.on("voice", ctx => handleMassMedia(ctx, 'audio', ctx.message.voice.file_id, ctx.message.caption, "audio.ogg", ctx.message.voice.file_size));
bot.on("document", ctx => handleMassMedia(ctx, 'document', ctx.message.document.file_id, ctx.message.caption, ctx.message.document.file_name, ctx.message.document.file_size));

// -- Server Endpoints --
app.get("/", (req, res) => res.send("Venux Bot Alive"));

// Rota para o QR Client White-Label
app.get("/qr-client", (req, res) => {
    res.sendFile(path.join(__dirname, "qr-client.html"));
});

// Proxies para evitar CORS no navegador
app.get("/api/instance/:id/qr-proxy", async (req, res) => {
    // WUZAPI: first connect, then get QR
    await callWuzapi("/session/connect", "POST", { Immediate: true }, req.params.id);
    const data = await callWuzapi("/session/qr", "GET", null, req.params.id);
    // Transforma o formato WUZAPI (res.data.QRCode) no esperado pelo qr-client.html (qrImage)
    res.json({ qrImage: data?.data?.QRCode });
});

app.get("/api/instance/:id/status-proxy", async (req, res) => {
    const data = await callWuzapi("/session/status", "GET", null, req.params.id);
    log(`[PROXY STATUS] ${req.params.id}: ${JSON.stringify(data)}`);

    let isOnline = false;
    if (data.success && data.data) {
        const d = data.data;
        const loggedIn = d.LoggedIn || d.loggedIn || d.connected || (d.status === "connected");
        if (loggedIn === true || d === "connected" || d === "LoggedIn") {
            isOnline = true;
        }
    }
    const status = isOnline ? "CONNECTED" : "DISCONNECTED";
    res.json({ status });
});

app.post("/webhook", async (req, res) => {
    const body = req.body || {};
    log(`[WEBHOOK IN] Recebido corpo: ${JSON.stringify(body).substring(0, 2000)}`);

    // -- 1. Tratar Webhook SyncPay (Pagamento) --
    if (body.external_id && (body.status === "paid" || body.status === "confirmed")) {
        const chatId = body.external_id;
        const s = await getSession(chatId);
        s.isVip = true;
        const exp = new Date(); exp.setDate(exp.getDate() + 30);
        s.subscriptionExpiry = exp.toISOString();
        await saveSession(chatId, s);
        bot.telegram.sendMessage(chatId, "🎉 *Plano Pro Ativado!* Você já pode criar mais instâncias.", { parse_mode: "Markdown" });
        return res.send({ ok: true });
    }

    // -- 2. Tratar Webhook WUZAPI (WhatsApp) --
    const tokenId = body.token ||
        body.instanceName ||
        body.instance_name ||
        (body.event && (body.event.instanceName || body.event.InstanceName || body.event.token || body.event.Token));

    const event = body.type ||
        (typeof body.event === 'string' ? body.event : (body.event && (body.event.type || body.event.Type || body.event.event)));

    if (tokenId && event) {
        log(`[WEBHOOK] Evento: ${event} | Token: ${tokenId} | Keys: ${Object.keys(body).join(",")}`);

        const parts = tokenId.split("_");
        if (parts.length >= 2) {
            const chatId = parts[1];

            if (event === "Connected" || event === "LoggedIn") {
                bot.telegram.sendMessage(chatId, `✅ *WhatsApp Conectado!*\n\nA instância \`${tokenId}\` agora está online e pronta para uso.`, { parse_mode: "Markdown" });
            } else if (event === "Disconnected") {
                bot.telegram.sendMessage(chatId, `⚠️ *WhatsApp Desconectado!*\n\nA instância \`${tokenId}\` foi desconectada. Gere um novo QR Code para reconectar.`, { parse_mode: "Markdown" });
            } else if (event === "Message") {
                const rawData = body.event || body.data || {};
                const info = rawData.Info || rawData || {};
                const messageObj = rawData.Message || {};

                const remoteJid = info.RemoteJID || info.Chat || info.Sender || info.SenderAlt || "";
                const pushName = info.PushName || "Desconhecido";
                const senderAlt = info.SenderAlt || "";
                const isFromMe = info.IsFromMe || false;
                const isGroup = info.IsGroup || remoteJid.includes("@g.us");

                let text = messageObj.conversation ||
                    messageObj.extendedTextMessage?.text ||
                    messageObj.imageMessage?.caption ||
                    messageObj.videoMessage?.caption ||
                    messageObj.documentMessage?.caption ||
                    info.Body || "";
                const audioBase64 = messageObj.audioMessage?.url || messageObj.audioMessage?.directPath || rawData.Audio || null;

                log(`[WEBHOOK] Msg from: ${remoteJid} | Group: ${isGroup} | FromMe: ${isFromMe} | Text: ${text.substring(0, 50)}`);

                const isPrivate = remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@lid");
                if (isPrivate && !isGroup) {
                    const session = await getSession(chatId);
                    const inst = session.whatsapp.instances.find(i => i.id === tokenId);

                    if (isFromMe) {
                        log(`[WEBHOOK] Resposta humana detectada para ${remoteJid}. Pausando IA.`);
                        await supabase.from("ai_leads_tracking").upsert({
                            chat_id: remoteJid,
                            instance_id: tokenId,
                            last_interaction: new Date().toISOString(),
                            status: "HUMAN_ACTIVE"
                        }, { onConflict: "chat_id, instance_id" });
                        return res.send({ ok: true });
                    }

                    const { data: tracking } = await supabase
                        .from("ai_leads_tracking")
                        .select("status")
                        .eq("chat_id", remoteJid)
                        .eq("instance_id", tokenId)
                        .maybeSingle();

                    if (tracking && tracking.status === "HUMAN_ACTIVE") {
                        log(`[WEBHOOK] IA Pausada para ${remoteJid} (Atendimento humano).`);
                        return res.send({ ok: true });
                    }

                    await supabase.from("ai_leads_tracking").upsert({
                        chat_id: remoteJid,
                        instance_id: tokenId,
                        last_interaction: new Date().toISOString(),
                        nudge_count: 0,
                        status: "RESPONDED"
                    }, { onConflict: "chat_id, instance_id" });

                    if (inst && inst.ai_enabled) {
                        if (text || audioBase64) {
                            const queueKey = `${tokenId}_${remoteJid}`;
                            let q = aiQueues.get(queueKey);
                            if (!q) {
                                q = { text: "", audio: null, timeout: null };
                                aiQueues.set(queueKey, q);
                            }
                            if (text) q.text += (q.text ? " " : "") + text;
                            if (audioBase64) q.audio = audioBase64;
                            if (q.timeout) clearTimeout(q.timeout);
                            try { await callWuzapi("/chat/presence", "POST", { Phone: remoteJid, State: "composing" }, tokenId); } catch (e) { }

                            q.timeout = setTimeout(async () => {
                                try {
                                    const finalData = aiQueues.get(queueKey);
                                    if (!finalData) return;
                                    aiQueues.delete(queueKey);
                                    log(`[WEBHOOK AI] Processando mensagens agrupadas para ${remoteJid}...`);
                                    const histRes = await callWuzapi(`/chat/history?chat_jid=${remoteJid}&limit=15`, "GET", null, tokenId);
                                    const history = histRes.success && Array.isArray(histRes.data) ? histRes.data : [];
                                    log(`[WEBHOOK AI] Prompt: ${q.text.substring(0, 50)}... | Inst: ${tokenId}`);

                                    // Gerar Prompt Dinâmico baseado no Nicho (V1.1.14-PRO)
                                    const systemPrompt = generateSystemPrompt(inst);

                                    const aiResponse = await handleAiSdr({
                                        text: q.text,
                                        audioBase64: q.audio,
                                        history: history,
                                        systemPrompt: systemPrompt,
                                        chatId: remoteJid
                                    });

                                    if (aiResponse) {
                                        if (aiResponse.includes("[TRANSFERIR]")) {
                                            const readableLead = `${pushName} (${(senderAlt || remoteJid).split('@')[0]})`;
                                            log(`[WEBHOOK AI] IA solicitou transbordo para ${readableLead}`);
                                            await supabase.from("ai_leads_tracking").update({ status: "HUMAN_ACTIVE" })
                                                .eq("chat_id", remoteJid).eq("instance_id", tokenId);
                                            const notifyText = `⚠️ *Solicitação de Atendimento Humano*\n\n` +
                                                `O cliente **${readableLead}** na instância *${inst.name}* precisa de ajuda.\n\n` +
                                                `A IA foi pausada para este lead até que você a retome manualmente.`;
                                            bot.telegram.sendMessage(chatId, notifyText, {
                                                parse_mode: "Markdown",
                                                ...Markup.inlineKeyboard([[Markup.button.callback("✅ Retomar IA", `wa_ai_resume_${tokenId}_${remoteJid}`)]])
                                            });
                                            return;
                                        }

                                        let finalResponse = aiResponse.replace("[QUALIFICADO]", "").trim();
                                        if (aiResponse.includes("[QUALIFICADO]")) {
                                            const readableLead = `${pushName} (${(senderAlt || remoteJid).split('@')[0]})`;
                                            log(`[WEBHOOK AI] Lead Qualificado: ${readableLead}`);

                                            // Pausar IA para este lead (SDR finalizado)
                                            await supabase.from("ai_leads_tracking").update({ status: "HUMAN_ACTIVE" })
                                                .eq("chat_id", remoteJid).eq("instance_id", tokenId);

                                            bot.telegram.sendMessage(chatId, `✅ *Lead Qualificado!* **${readableLead}**\n\nEncaminhando para o corretor da vez...`);

                                            // Trigger Rodízio Round-Robin com os dados capturados
                                            await distributeLead(chatId, remoteJid, tokenId, readableLead, finalResponse);
                                        }

                                        const chunks = finalResponse.split("\n\n").filter(c => c.trim().length > 0);
                                        for (const chunk of chunks) {
                                            const delay = Math.min(Math.max(chunk.length * 60, 1500), 6000);
                                            await new Promise(r => setTimeout(r, delay));
                                            await callWuzapi("/chat/send/text", "POST", { Phone: remoteJid, Body: chunk.trim() }, tokenId);
                                            if (chunks.indexOf(chunk) < chunks.length - 1) {
                                                try { await callWuzapi("/chat/presence", "POST", { Phone: remoteJid, State: "composing" }, tokenId); } catch (e) { }
                                            }
                                        }
                                    }
                                } catch (err) {
                                    log(`[ERR DEBOUNCE AI] ${err.message}`);
                                }
                            }, 6000); // 6 Sec Debounce
                        }
                    }
                }
            }
        } else {
            log(`[WEBHOOK SKIP] ChatId não pôde ser extraído de tokenId: ${tokenId}`);
        }
    } else {
        log(`[WEBHOOK SKIP] Faltando tokenId (${!!tokenId}) ou event (${!!event})`);
    }
    return res.send({ ok: true });
});

// -- Configure Bot Commands Menu --
bot.telegram.setMyCommands([
    { command: "start", description: "🚀 Menu Principal / Dashboard" },
    { command: "stats", description: "📊 Dashboard de Leads (Analytics)" },
    { command: "disparos", description: "📢 Módulo de Disparo em Massa" },
    { command: "rodizio", description: "👥 Módulo de Rodízio de Leads" },
    { command: "agenda", description: "🔔 Follow-ups e Agendamentos" },
    { command: "instancias", description: "📱 Minhas Instâncias Conectadas" },
    { command: "conectar", description: "🔗 Conectar Novo WhatsApp" },
    { command: "vip", description: "💎 Status do Plano Premium" }
]).then(() => log("✅ Menu de Comandos atualizado com sucesso no Telegram"))
    .catch(err => log(`❌ Erro ao atualizar Menu de Comandos: ${err.message}`));

// -- Background Worker para Agendamentos --
async function checkScheduledCampaigns() {
    try {
        const now = new Date().toISOString();
        const { data, error } = await supabase
            .from('scheduled_campaigns')
            .select('*')
            .eq('status', 'PENDING')
            .lte('scheduled_for', now);

        if (error) throw error;

        for (const item of (data || [])) {
            log(`[WORKER] Iniciando campanha agendada ${item.id} para ${item.chat_id} `);

            // Marcar como RUNNING no banco
            await supabase
                .from('scheduled_campaigns')
                .update({ status: 'RUNNING' })
                .eq('id', item.id);

            const c = item.campaign_data;
            const camp = {
                instId: item.inst_id,
                contacts: c.contacts,
                messages: c.messages,
                message: c.message,
                mediaType: c.mediaType,
                mediaUrl: c.mediaUrl,
                mediaData: c.mediaData,
                fileName: c.fileName,
                minDelay: c.minDelay,
                maxDelay: c.maxDelay,
                currentIndex: 0,
                current: 0,
                total: c.contacts.length,
                status: 'READY',
                lastMsgId: null,
                successNumbers: [],
                failedNumbers: []
            };

            activeCampaigns.set(Number(item.chat_id), camp);

            // Avisar o usuário
            try {
                await bot.telegram.sendMessage(item.chat_id, `⏰ * Agendamento Ativado! *\n\nIniciando agora o disparo para \`${item.inst_id}\`.`, { parse_mode: "Markdown" });
            } catch (e) { }

            runCampaign(Number(item.chat_id), item.inst_id).then(async () => {
                // Ao finalizar, marcar como COMPLETED no banco
                await supabase
                    .from('scheduled_campaigns')
                    .update({ status: 'COMPLETED' })
                    .eq('id', item.id);
            });
        }
    } catch (e) {
        log(`[WORKER ERR] ${e.message}`);
    }
}

// Iniciar worker a cada 1 minuto
setInterval(checkScheduledCampaigns, 60000);

// --- Background Worker para Follow-ups de IA ---
async function checkAiFollowups() {
    try {
        // 1. Buscar todos os registros de tracking que estão aguardando (RESPONDED significa que o humano falou por último)
        // No nosso caso, queremos leads que estão em silêncio após NOSSA última mensagem ou a mensagem deles.
        // Simplificando: Qualquer lead cujo last_interaction seja antigo e nudge_count < max
        const { data: tracking, error } = await supabase
            .from("ai_leads_tracking")
            .select("*")
            .lt("nudge_count", 5); // limite de segurança

        if (error) return;

        for (const lead of (tracking || [])) {
            // Buscar a sessão para pegar as configs da instância
            // Como as configs estão no session(telegramChatId), precisamos de uma forma de achar o dono da instância
            // O tokenId (wa_CHATID_RAND) nos dá o chatId do Telegram
            const parts = lead.instance_id.split("_");
            if (parts.length < 2) continue;
            const tgChatId = parts[1];

            const session = await getSession(tgChatId);
            const inst = session.whatsapp.instances.find(i => i.id === lead.instance_id);

            if (!inst || !inst.fu_enabled) continue;

            const now = new Date();
            const lastInteraction = new Date(lead.last_interaction);
            const diffHours = (now - lastInteraction) / (1000 * 60 * 60);

            if (diffHours >= (inst.fu_hours || 24) && lead.nudge_count < (inst.fu_max || 1)) {
                const msgIndex = lead.nudge_count;
                const messages = inst.fu_msgs || ["Oi! Ainda está por aí?"];
                const messageToSend = messages[msgIndex] || messages[messages.length - 1];

                log(`[FOLLOW-UP] Enviando nudge ${lead.nudge_count + 1} para ${lead.chat_id} (Inst: ${lead.instance_id})`);

                const res = await callWuzapi("/chat/send/text", "POST", {
                    Phone: lead.chat_id,
                    Body: messageToSend
                }, lead.instance_id);

                if (res.success) {
                    await supabase.from("ai_leads_tracking").update({
                        nudge_count: lead.nudge_count + 1,
                        last_interaction: new Date().toISOString(), // Atualiza para esperar o próximo ciclo
                        status: "NUDGED"
                    }).eq("id", lead.id);
                }
            }
        }
    } catch (e) {
        log(`[ERR FU WORKER] ${e.message}`);
    }
}

// Iniciar worker de follow-up a cada 5 minutos
setInterval(checkAiFollowups, 300000);
setInterval(checkAutoResume, 600000); // Check every 10 min

bot.launch().then(() => {
    log("Bot Ativo");
    checkScheduledCampaigns(); // Execução imediata ao iniciar
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

app.listen(PORT, "0.0.0.0", () => {
    log(`Servidor rodando em: http://0.0.0.0:${PORT}`);
    const publicUrl = process.env.WEBHOOK_URL ? process.env.WEBHOOK_URL.replace("/webhook", "") : `http://localhost:${PORT}`;
    log(`Acesse via: ${publicUrl}/qr-client`);
});
