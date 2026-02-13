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
import { PDFParse } from "pdf-parse";

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
const sessionCache = new Map(); // V1.245: Cache de leitura para performance
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos de TTL

async function getSession(chatId) {
    const id = String(chatId);
    const now = Date.now();

    // V1.245: Cache de leitura para performance
    if (sessionCache.has(id)) {
        const cached = sessionCache.get(id);
        if (now - cached.timestamp < CACHE_TTL) {
            return cached.data;
        }
    }

    // Tenta buscar no banco
    const { data, error } = await supabase
        .from('bot_sessions')
        .select('data')
        .eq('chat_id', id)
        .single();

    if (error) {
        if (error.code === 'PGRST116') {
            log(`[DB] Criando nova sessão padrão para ${id}`);
        } else {
            // V1.243: Proteção Crítica - Se houver erro de conexão, NÃO prossegue para criar padrão
            // Isso evita sobrescrever sessões VIP com dados vazios em caso de instabilidade no Supabase.
            log(`[DB ERR] Falha crítica ao buscar sessão ${id}: ${error.message}`);
            throw new Error(`DB_FETCH_FAILED: ${error.message}`);
        }
    }

    let sessionObj;
    if (data) {
        // Log reduzido para v1.245 (Apenas se quiser depurar profundamente habilite)
        // log(`[DB DEBUG] Sessão encontrada para ${id}. Verificando integridade...`);
        sessionObj = data.data;

        // V1.244: Auto-Cura Profunda (Deep Healing)
        // Garante que sub-objetos existam mesmo se o JSON no banco estiver incompleto
        if (!sessionObj.whatsapp) sessionObj.whatsapp = {};
        if (!Array.isArray(sessionObj.whatsapp.instances)) sessionObj.whatsapp.instances = [];
        if (typeof sessionObj.whatsapp.maxInstances !== 'number') sessionObj.whatsapp.maxInstances = 1;

        if (!sessionObj.affiliate) sessionObj.affiliate = {};
        if (typeof sessionObj.affiliate.balance !== 'number') sessionObj.affiliate.balance = 0;
        if (typeof sessionObj.affiliate.totalEarned !== 'number') sessionObj.affiliate.totalEarned = 0;

        if (!sessionObj.reports) sessionObj.reports = {};
        if (!sessionObj.stage) sessionObj.stage = "READY";
    } else {
        // Se não existir, cria padrão
        sessionObj = {
            stage: "START",
            isVip: false,
            subscriptionExpiry: null,
            referredBy: null,
            affiliate: {
                balance: 0,
                totalEarned: 0,
                referralsCount: 0,
                conversionsCount: 0
            },
            whatsapp: { instances: [], maxInstances: 1 },
            reports: {}
        };
        await saveSession(id, sessionObj);
    }

    // Atualiza cache
    sessionCache.set(id, { data: sessionObj, timestamp: now });
    return sessionObj;
}

async function saveSession(chatId, sessionData) {
    const id = String(chatId);

    // Atualiza cache imediatamente
    sessionCache.set(id, { data: sessionData, timestamp: Date.now() });

    const { error } = await supabase
        .from('bot_sessions')
        .upsert({
            chat_id: id,
            data: sessionData,
            updated_at: new Date().toISOString()
        });

    if (error) log(`[DB ERR] Erro ao salvar sessão ${id}: ${error.message}`);
}

// Helper para salvar sessão atual rapidamente
async function syncSession(ctx, session) {
    await saveSession(ctx.chat.id, session);
}

const SERVER_VERSION = "1.264";

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
        return { inst: null, session };
    }
    return { inst, session };
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
        referralCommission: 10.00,
        supportLink: "@ConnectSuporte",
        tutorialLink: "https://t.me/seu_canal_de_tutoriais",
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
            await ctx.editMessageText(text, { parse_mode: "HTML", ...extra });
            session.last_menu_id = ctx.callbackQuery.message.message_id;
            await syncSession(ctx, session);
        } catch (e) {
            await killOld();
            const sent = await ctx.reply(text, { parse_mode: "HTML", ...extra });
            session.last_menu_id = sent.message_id;
            await syncSession(ctx, session);
        }
    } else {
        await killOld();
        const sent = await ctx.reply(text, { parse_mode: "HTML", ...extra });
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

// Helper para normalizar JIDs brasileiros (discrepância do 9º dígito)
function normalizeJid(jid) {
    if (!jid || typeof jid !== "string" || !jid.includes("@")) return jid;
    const [number, server] = jid.split("@");
    if (server !== "s.whatsapp.net") return jid;

    // Se começa com 55 e tem 13 dígitos, remove o 9 (ex: 5591988887777 -> 559188887777)
    if (number.startsWith("55") && number.length === 13) {
        return number.substring(0, 4) + number.substring(5) + "@" + server;
    }
    return jid;
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

async function createSyncPayPix(chatId, amount, name = "Usuario Connect") {
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
                description: `Assinatura Connect WhatsApp Pro - ID ${chatId}`,
                webhook_url: WEBHOOK_URL,
                external_id: String(chatId),
                client: { name, cpf: "00000000000", email: "cliente@vendas.com", phone: "00000000000" }
            })
        });
        const json = await res.json();
        if (json.error || !json.pix_code) {
            log(`[API PIX ERR] Response: ${JSON.stringify(json)}`);
        }
        return json;
    } catch (e) {
        log(`[ERR PIX FETCH] ${e.message}`);
        return { error: true };
    }
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

    const text = `👑 <b>Painel Admin SaaS</b>\n\n` +
        `👥 <b>Usuários:</b> ${count || 0}\n` +
        `💰 <b>Preço Atual:</b> R$ ${config.planPrice.toFixed(2)}\n` +
        `💎 <b>Limite Instâncias VIP:</b> ${config.limits.vip.instances}\n` +
        `🤝 <b>Corretores:</b> Liberados (Ilimitados)\n` +
        `👤 <b>Suporte:</b> <code>${config.supportLink || "Não definido"}</code>\n` +
        `📺 <b>Tutoriais:</b> <code>${config.tutorialLink || "Não definido"}</code>\n`;

    const buttons = [
        [Markup.button.callback("📢 Broadcast (Msg em Massa)", "admin_broadcast")],
        [Markup.button.callback("💰 Alterar Preço", "admin_price"), Markup.button.callback("👤 Configurar Suporte", "admin_support")],
        [Markup.button.callback("💎 Ajustar Limite", "admin_limit_vip"), Markup.button.callback("📺 Configurar Tutoriais", "admin_tutorial_link")],
        [Markup.button.callback("👤 Ativar VIP Manual", "admin_vip_manual")],
        [Markup.button.callback("🔙 Voltar", "start")]
    ];
    await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
}

bot.command("id", (ctx) => {
    ctx.reply(`🆔 *Seu ID:* \`${ctx.chat.id}\``, { parse_mode: "Markdown" });
});

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

bot.action("admin_support", async (ctx) => {
    safeAnswer(ctx);
    const session = await getSession(ctx.chat.id);
    session.stage = "ADMIN_WAIT_SUPPORT";
    await syncSession(ctx, session);
    ctx.reply("👤 *Configurar Suporte*\n\nDigite o novo @username ou Link de Suporte:", { parse_mode: "Markdown" });
});

bot.action("admin_tutorial_link", async (ctx) => {
    safeAnswer(ctx);
    const session = await getSession(ctx.chat.id);
    session.stage = "ADMIN_WAIT_TUTORIAL";
    await syncSession(ctx, session);
    ctx.reply("📺 *Configurar Tutoriais*\n\nDigite o novo Link do Canal/Vídeos:", { parse_mode: "Markdown" });
});

bot.action("admin_limit_vip", async (ctx) => {
    safeAnswer(ctx);
    const session = await getSession(ctx.chat.id);
    session.stage = "ADMIN_WAIT_LIMIT_VIP";
    await syncSession(ctx, session);
    ctx.reply("💎 *Limite de Instâncias VIP*\n\nDigite apenas o número máximo de instâncias que um usuário PRO pode ter (ex: 5):", { parse_mode: "Markdown" });
});

// --- User Management Handlers ---
bot.action("admin_users_menu", async (ctx) => {
    safeAnswer(ctx);
    const config = await getSystemConfig();
    if (!isAdmin(ctx.chat.id, config)) return;

    // Contagem rápida
    const { count } = await supabase.from('bot_sessions').select('*', { count: 'exact', head: true });

    const text = `👥 *Gerenciar Usuários*\n\n` +
        `Total de Usuários: **${count || 0}**\n\n` +
        `Selecione uma opção:`;

    const buttons = [
        [Markup.button.callback("🔍 Buscar por ID (ChatID)", "admin_search_user")],
        [Markup.button.callback("🔙 Voltar", "cmd_admin_panel")]
    ];

    await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
});

bot.action("admin_search_user", async (ctx) => {
    safeAnswer(ctx);
    const session = await getSession(ctx.chat.id);
    session.stage = "ADMIN_WAIT_USER_SEARCH";
    await syncSession(ctx, session);
    ctx.reply("🔍 *Buscar Usuário*\n\nDigite o **Chat ID** do usuário que deseja gerenciar:", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "admin_users_menu")]])
    });
});

async function renderUserDetails(ctx, targetChatId) {
    const s = await getSession(targetChatId);
    if (!s) return ctx.reply("❌ Usuário não encontrado.");

    const isVip = s.isVip;
    const expiry = s.subscriptionExpiry ? new Date(s.subscriptionExpiry).toLocaleDateString('pt-BR') : "N/A";
    const blocked = s.blocked || false;

    const text = `👤 <b>Detalhes do Usuário</b>\n\n` +
        `🆔 ID: <code>${targetChatId}</code>\n` +
        `👤 Nome: ${s.firstName || "Desconhecido"}\n` +
        `💎 VIP: ${isVip ? "SIM" : "NÃO"}\n` +
        `📅 Expira em: ${expiry}\n` +
        `🚫 Bloqueado: ${blocked ? "SIM" : "NÃO"}\n` +
        `🤖 Instâncias: ${s.whatsapp?.instances?.length || 0}`;

    const buttons = [
        [Markup.button.callback(isVip ? "❌ Remover VIP" : "💎 Dar VIP (30 dias)", `admin_toggle_vip_${targetChatId}`)],
        [Markup.button.callback(blocked ? "✅ Desbloquear" : "🚫 Bloquear Acesso", `admin_toggle_block_${targetChatId}`)],
        [Markup.button.callback("🔙 Voltar", "admin_search_user")]
    ];

    await ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
}

// Handlers dinâmicos para ações de usuário
bot.action(/^admin_toggle_vip_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const targetId = ctx.match[1];
    const s = await getSession(targetId);

    s.isVip = !s.isVip;
    if (s.isVip) {
        const exp = new Date(); exp.setDate(exp.getDate() + 30);
        s.subscriptionExpiry = exp.toISOString();
    } else {
        s.subscriptionExpiry = null;
    }

    await saveSession(targetId, s);
    try {
        if (s.isVip) await bot.telegram.sendMessage(targetId, "💎 *Parabéns!* Seu plano VIP foi ativado pelo administrador.");
        else await bot.telegram.sendMessage(targetId, "⚠️ *Atenção:* Seu plano VIP foi revogado.");
    } catch (e) { }

    await renderUserDetails(ctx, targetId);
});

bot.action(/^admin_toggle_block_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const targetId = ctx.match[1];
    const s = await getSession(targetId);

    s.blocked = !s.blocked;
    await saveSession(targetId, s);

    await renderUserDetails(ctx, targetId);
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

    // --- Lógica de Afiliados: Atribuição ---
    const payload = ctx.startPayload; // Captura o ID do link: t.me/bot?start=ID
    const session = await getSession(ctx.chat.id);

    if (payload && !session.referredBy && String(payload) !== String(ctx.chat.id)) {
        // Verifica se o padrinho existe
        const referrerId = String(payload);
        const refSession = await getSession(referrerId);

        if (refSession) {
            session.referredBy = referrerId;
            refSession.affiliate.referralsCount = (refSession.affiliate.referralsCount || 0) + 1;
            await saveSession(referrerId, refSession);
            log(`[AFFILIATE] Novo indicado para ${referrerId}: ${ctx.chat.id}`);

            // Avisar o padrinho (opcional, mas motivador)
            try {
                bot.telegram.sendMessage(referrerId, `🤝 <b>Nova Indicação!</b> \n\n${userFirstName} entrou pelo seu link. Se ele(a) assinar, você ganha comissão!`, { parse_mode: "HTML" });
            } catch (e) { }
        }
    }
    await syncSession(ctx, session);

    // V1.247: Mudança global para HTML para evitar erros de Markdown com nomes/links
    const welcomeMsg = `👋 <b>Olá, ${userFirstName}! Bem-vindo ao Connect SaaS</b> 🚀\n\n` +
        `O sistema definitivo para automação de WhatsApp com IA e Rodízio de Leads.\n\n` +
        `👇 <b>Escolha uma opção no menu abaixo:</b>`;

    if (!isVip && !isAdmin(ctx.chat.id, config)) {
        return renderTourMenu(ctx, 0);
    }

    const buttons = [
        [Markup.button.callback("🚀 Minhas Instâncias", "cmd_instancias_menu")],
        [Markup.button.callback("📢 Disparo em Massa", "cmd_shortcuts_disparos"), Markup.button.callback("🤝 Afiliados", "cmd_afiliados")],
        [Markup.button.callback("🔔 Follow-ups / Agenda", "cmd_shortcuts_followups")],
        [Markup.button.callback("💎 Seu Plano (Ativo)", "cmd_planos_menu"), Markup.button.callback("👤 Suporte / Ajuda", "cmd_suporte")]
    ];

    if (isVip || isAdmin(ctx.chat.id, config)) {
        buttons.push([Markup.button.callback("📺 Área de Tutoriais", "cmd_tutoriais")]);
    }

    if (isAdmin(ctx.chat.id, config)) {
        buttons.push([Markup.button.callback("👑 Painel Admin", "cmd_admin_panel")]);
    }

    await safeEdit(ctx, welcomeMsg, Markup.inlineKeyboard(buttons));
});

bot.command("debug_id", async (ctx) => {
    const session = await getSession(ctx.chat.id);
    ctx.reply(`🆔 *Debug ID Info*\n\n` +
        `• Seu ChatID: \`${ctx.chat.id}\`\n` +
        `• Tipo do ID no Contexto: \`${typeof ctx.chat.id}\`\n` +
        `• VIP Ativo no Banco: \`${session.isVip ? "SIM" : "NÃO"}\`\n` +
        `• Instâncias no Objeto: \`${session.whatsapp?.instances?.length || 0}\`\n` +
        `• Versão do Servidor: \`${SERVER_VERSION}\``, { parse_mode: "Markdown" });
});

// --- Tour de Funcionalidades ---
async function renderTourMenu(ctx, step = 0) {
    const config = await getSystemConfig();
    let text = "";
    let buttons = [];

    const steps = [
        {
            title: "🚀 Bem-vindo ao Connect SaaS!",
            description: "Você acaba de acessar a plataforma mais completa para automação de vendas via WhatsApp.\n\nNossa tecnologia permite que você tenha um <b>SDR Artificial</b> trabalhando 24h por dia, qualificando leads e fechando negócios enquanto você dorme.",
            btnNext: "Conhecer IAs 🤖"
        },
        {
            title: "🏠 IA para Imobiliárias",
            description: "Imagine uma IA que:\n✅ Conhece todo seu catálogo de imóveis.\n✅ Qualifica o lead (Preço, Região, Tipo).\n✅ Envia o contato direto para o corretor responsável.\n✅ Agenda visitas sozinho.",
            btnNext: "IA para Clínicas 🏥"
        },
        {
            title: "🏥 IA para Clínicas & Médicos",
            description: "Automatize seu consultório:\n✅ Tira dúvidas sobre convênios.\n✅ Explica especialidades.\n✅ Envia link de agendamento automático.\n✅ Filtra urgências de consultas de rotina.",
            btnNext: "Disparos em Massa 📢"
        },
        {
            title: "📢 Disparo em Massa Inteligente",
            description: "Alcance milhares de clientes:\n✅ Variáveis dinâmicas <code>{{nome}}</code>.\n✅ Delay aleatório anti-ban.\n✅ Suporte a fotos, vídeos e áudios.\n✅ Campanhas agendadas.",
            btnNext: "Rodízio & Gestão 👥"
        },
        {
            title: "👥 Rodízio & Automações",
            description: "Gestão profissional de leads:\n✅ Distribua leads entre sua equipe (Fila/Rodízio).\n✅ Follow-ups automáticos (IA cobra o lead se ele não responder).\n✅ Dashboard de estatísticas em tempo real.",
            btnNext: "💎 Começar Agora"
        },
        {
            title: "💎 Escolha seu Sucesso",
            description: `Tudo isso liberado imediatamente após a assinatura.\n\n💰 <b>Investimento:</b> R$ ${config.planPrice.toFixed(2)}/mês\n\nSem taxas de adesão. Cancele quando quiser.`,
            btnNext: "🔥 ASSINAR AGORA (PIX)"
        }
    ];

    const s = steps[step];
    text = `<b>Step ${step + 1}/${steps.length}</b>\n\n` +
        `<b>${s.title}</b>\n\n` +
        `${s.description}`;

    if (step < steps.length - 1) {
        buttons.push([Markup.button.callback(s.btnNext, `tour_step_${step + 1}`)]);
    } else {
        buttons.push([Markup.button.callback(s.btnNext, "gen_pix_mensal")]);
    }

    if (step > 0) {
        buttons.push([Markup.button.callback("⬅️ Anterior", `tour_step_${step - 1}`)]);
    }

    buttons.push([Markup.button.callback("👤 Falar com Suporte", "cmd_suporte")]);

    await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
}

bot.action(/^tour_step_(\d+)$/, async (ctx) => {
    safeAnswer(ctx);
    const step = parseInt(ctx.match[1]);
    await renderTourMenu(ctx, step);
});

// --- Menu Handlers ---


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
        const instIds = (session.whatsapp?.instances || []).map(i => i.id);

        if (instIds.length === 0) return ctx.reply("❌ Você ainda não possui instâncias configuradas.");

        // 1. Leads Qualificados Totais (Usando rodizio_leads como fallback se ai_leads_tracking não existir)
        const { data: leads, error } = await supabase
            .from("qualification_leads") // Tabela correta para leads qualificados
            .select("*")
            .in("instance_id", instIds)
            .eq("status", "HUMAN_ACTIVE");

        if (error) {
            log(`[STATS DB ERR] ${error.message}`);
            return ctx.reply("❌ Erro ao acessar o banco de dados de estatísticas.");
        }

        const leadsList = leads || [];

        // 2. Leads de Hoje
        const today = new Date().toISOString().split('T')[0];
        const leadsToday = leadsList.filter(l => l.last_interaction && l.last_interaction.startsWith(today));

        // 3. Stats por Instância
        let instStats = "";
        for (const inst of (session.whatsapp?.instances || [])) {
            const count = leadsList.filter(l => l.instance_id === inst.id).length;
            instStats += `- *${inst.name}:* ${count} leads qualificados\n`;
        }

        const msg = `📊 *Dashboard de Leads (Analytics)*\n\n` +
            `🔥 *Leads Qualificados (Total):* ${leadsList.length}\n` +
            `📅 *Leads de Hoje:* ${leadsToday.length}\n\n` +
            `📱 *Performance por Instância:*\n${instStats || '_Sem dados_'}\n\n` +
            `💡 *Dica:* Seus leads qualificados são aqueles que foram pausados para atendimento humano ou entregues via rodízio.`;

        ctx.reply(msg, { parse_mode: "Markdown" });
    } catch (e) {
        log(`[STATS FATAL] ${e.message}`);
        ctx.reply("❌ Erro inesperado ao gerar estatísticas.");
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
    const welcomeMsg = `👋 *Olá, ${userFirstName}! Bem-vindo ao Connect SaaS* 🚀\n\n` +
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
        `👤 Corretores: Ilimitado\n`;

    const buttons = [];
    if (!isVip) buttons.push([Markup.button.callback("💎 Assinar Agora (Pix)", "gen_pix_mensal")]);
    buttons.push([Markup.button.callback("🔙 Voltar", "start")]);

    ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action("cmd_suporte", async (ctx) => {
    safeAnswer(ctx);
    const config = await getSystemConfig();
    ctx.editMessageText(`👤 <b>Suporte & Ajuda</b>\n\nPrecisa de ajuda? Entre em contato com o suporte oficial:\n\n👉 ${config.supportLink || "@SeuUsuarioDeSuporte"}`, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "start")]])
    });
});

bot.action("cmd_tutoriais", async (ctx) => {
    safeAnswer(ctx);
    const isVip = await checkVip(ctx.chat.id);
    const config = await getSystemConfig();

    if (!isVip && !isAdmin(ctx.chat.id, config)) {
        return ctx.reply("❌ *Acesso Restrito*\n\nA área de tutoriais é exclusiva para assinantes Pro ativos.", { parse_mode: "Markdown" });
    }

    ctx.editMessageText(`📺 <b>Área de Tutoriais Exclusiva</b>\n\nAcesse nossa central de vídeos para aprender a usar todo o potencial do Connect:\n\n👉 ${config.tutorialLink || "Ainda não configurado"}`, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "start")]])
    });
});

async function renderAffiliateMenu(ctx) {
    const session = await getSession(ctx.chat.id);
    const botInfo = await ctx.telegram.getMe();
    const affLink = `https://t.me/${botInfo.username}?start=${ctx.chat.id}`;
    const aff = session.affiliate || { balance: 0, referralsCount: 0, conversionsCount: 0 };

    const text = `🤝 <b>Sistema de Afiliados Connect</b>\n\n` +
        `Indique o Connect para seus amigos e ganhe comissão por cada assinatura confirmada!\n\n` +
        `🔗 <b>Seu Link de Indicação:</b> \n<code>${affLink}</code>\n\n` +
        `📊 <b>Suas Estatísticas:</b>\n` +
        `👤 Indicados: ${aff.referralsCount || 0}\n` +
        `✅ Vendas Convertidas: ${aff.conversionsCount || 0}\n` +
        `💰 <b>Saldo Atual: R$ ${(aff.balance || 0).toFixed(2)}</b>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📢 <b>Como funciona?</b>\n` +
        `1. Você compartilha seu link.\n` +
        `2. Alguém entra e assina o Plano Pro.\n` +
        `3. Você ganha <b>R$ 10,00</b> de comissão na hora no seu saldo!`;

    const buttons = [
        [Markup.button.callback("💸 Solicitar Saque", "gen_withdraw_pix")],
        [Markup.button.callback("🔙 Voltar", "start")]
    ];

    await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
}

bot.action("cmd_afiliados", async (ctx) => {
    safeAnswer(ctx);
    await renderAffiliateMenu(ctx);
});

bot.action("gen_withdraw_pix", async (ctx) => {
    safeAnswer(ctx);
    const session = await getSession(ctx.chat.id);
    const aff = session.affiliate || { balance: 0 };

    if (aff.balance < 10) {
        return ctx.reply("❌ *Saldo Insuficiente*\n\nO valor mínimo para saque é de R$ 10,00.", { parse_mode: "Markdown" });
    }

    session.stage = "ADMIN_WAIT_WITHDRAW_PIX";
    await syncSession(ctx, session);
    ctx.reply("💸 *Solicitar Saque*\n\nQual o seu **PIX (Chave e Tipo)** para recebimento?\n\nExemplo: `000.000.000-00 (CPF)`", { parse_mode: "Markdown" });
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
    let msg = `📱 *Suas Instâncias (v${SERVER_VERSION}):*\n\n`;
    const buttons = [];

    // V1.244: Check de segurança extra
    if (!session.whatsapp || !Array.isArray(session.whatsapp.instances) || session.whatsapp.instances.length === 0) {
        msg += "_Nenhuma instância encontrada._\n";
    } else {
        for (const inst of session.whatsapp.instances) {
            // ... (o loop continua abaixo)
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

            let phoneInfo = `🆔 \`${inst.id}\``;
            if (isOnline && stats.data?.jid) {
                const phoneNumber = stats.data.jid.split(":")[0].split("@")[0];
                phoneInfo = `📱 **${phoneNumber}**`;
            }

            const status = isOnline ? "✅ On" : "❌ Off";
            msg += `🔹 **${inst.name}**\n${phoneInfo}\n📡 Status: ${status}\n\n`;
            buttons.push([Markup.button.callback(`⚙️ Gerenciar ${inst.name}`, `manage_${inst.id}`)]);
        }
    }

    const isVip = await checkVip(ctx.chat.id);
    const config = await getSystemConfig();
    const isAdminUser = isAdmin(ctx.chat.id, config);

    // Botão de Nova Conexão visível para quem pode criar
    if (isAdminUser || (isVip && session.whatsapp.instances.length < config.limits.vip.instances)) {
        buttons.push([Markup.button.callback("➕ Conectar Novo Número", "cmd_conectar")]);
    } else if (!isVip && !isAdminUser) {
        buttons.push([Markup.button.callback("💎 Assinar para Conectar", "cmd_planos_menu")]);
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
        return safeEdit(ctx, "❌ Você precisa de uma assinatura VIP ativa para conectar instâncias.",
            Markup.inlineKeyboard([[Markup.button.callback("💎 Gerar Pix", "gen_pix_mensal")], [Markup.button.callback("🔙 Voltar", "cmd_instancias_menu")]])
        );
    }

    if (!isAdminUser && session.whatsapp.instances.length >= config.limits.vip.instances) {
        return safeEdit(ctx, `⚠️ <b>Limite de Instâncias Atingido!</b>\n\nSeu plano permite apenas ${config.limits.vip.instances} instâncias.\n\nFale com o suporte ou use /admin se for o dono.`,
            Markup.inlineKeyboard([[Markup.button.callback("💎 Ver Planos", "cmd_planos_menu")], [Markup.button.callback("🔙 Voltar", "cmd_instancias_menu")]])
            , { parse_mode: "HTML" }
        );
    }
    await safeEdit(ctx, "🔗 <b>Nova Conexão</b>\n\nDigite um <b>Nome</b> para identificar esta instância:", Markup.inlineKeyboard([[Markup.button.callback("❌ Cancelar", "cmd_instancias_menu")]]));
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

bot.action("cmd_instancias_menu", async (ctx) => {
    safeAnswer(ctx);
    return showInstances(ctx);
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

    buttons.push([Markup.button.callback("👥 Rodízio de Atendimento", `wa_brokers_menu_${id}`)]);

    buttons.push([Markup.button.callback("🚪 Logout", `wa_logout_${id}`), Markup.button.callback("🗑️ Deletar", `wa_del_${id}`)]);
    buttons.push([Markup.button.callback("🔙 Voltar", "cmd_instancias")]);

    let title = isOnline ? `✅ *Painel da Instância: ${id}*\n📱 *Número:* \`${phone}\`` : `🛠️ *Painel da Instância: ${id}*`;

    await safeEdit(ctx, title, Markup.inlineKeyboard(buttons));
}

bot.action(/^manage_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    await renderManageMenu(ctx, id);
});

// Handler para tela de integração API
bot.action(/^wa_api_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;

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
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;

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

// This block was likely part of a bot.action handler that was removed or misplaced.
// The user's instruction implies it should be part of a `wa_mass_init_` handler.
// Assuming it's the start of `wa_mass_init_`
bot.action(/^wa_mass_init_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;

    if (activeCampaigns.has(ctx.chat.id)) {
        return ctx.reply("⚠️ Você já tem um disparo em andamento. Aguarde a conclusão ou cancele.", {
            ...Markup.inlineKeyboard([[Markup.button.callback("🛑 Parar Disparo Atual", `wa_stop_mass`)]])
        });
    }

    session.stage = `WA_WAITING_MASS_CONTACTS_${id}`;
    await syncSession(ctx, session);

    const text = "🚀 <b>Configuração de Disparo em Massa</b>\n\nO que deseja fazer?";
    const extra = {
        parse_mode: "HTML",
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
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;

    ctx.editMessageText("📢 <b>Módulo de Disparo em Massa</b>\n\nSelecione o tipo de destinatário:", {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
            [Markup.button.callback("👤 Contatos (via .txt)", `wa_mass_start_txt_${id}`)],
            [Markup.button.callback("👥 Grupos da Instância", `wa_mass_groups_fetch_${id}`)],
            [Markup.button.callback("🔙 Voltar", `wa_mass_init_${id}`)]
        ])
    });
});

bot.action(/^wa_mass_start_txt_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;

    session.stage = `WA_WAITING_MASS_CONTACTS_${id}`;
    await syncSession(ctx, session);

    // Texto original do wa_mass_init_ (agora movido para cá)
    ctx.editMessageText("📢 *Disparo em Massa (Individual)*\n\nPor favor, envie um arquivo *.txt* contendo os números (um por linha).\n\nFormato: `Nome;5511999998888` ou apenas `5511999998888`.", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", `wa_mass_new_start_${id}`)]])
    });
});

// --- NOVO: Lógica de Grupos ---

bot.action(/^wa_mass_groups_fetch_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, instId);
    if (!inst) return;

    ctx.editMessageText("⏳ *Extraindo grupos...* Aguarde.", { parse_mode: "Markdown" });

    // Buscar grupos da API
    const res = await callWuzapi("/group/list", "GET", null, instId);

    if (!res.success || !res.data || !res.data.Groups) {
        return ctx.editMessageText("❌ Falha ao buscar grupos ou nenhum grupo encontrado.", {
            ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", `wa_mass_init_${instId}`)]])
        });
    }

    const groups = res.data.Groups.map(g => ({
        name: g.Name || "Sem Nome",
        id: g.JID,
        selected: false
    }));

    if (groups.length === 0) {
        return ctx.editMessageText("⚠️ Nenhum grupo encontrado nesta instância.", {
            ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", `wa_mass_init_${instId}`)]])
        });
    }

    // Salvar na sessão temporária
    session.temp_groups = groups;
    session.temp_groups_page = 0;
    await syncSession(ctx, session);

    await renderGroupSelection(ctx, instId);
});

async function renderGroupSelection(ctx, instId) {
    const session = await getSession(ctx.chat.id);
    const groups = session.temp_groups || [];
    const page = session.temp_groups_page || 0;
    const PAGE_SIZE = 8;

    const totalPages = Math.ceil(groups.length / PAGE_SIZE);
    const start = page * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const slice = groups.slice(start, end);

    const buttons = slice.map(g => {
        const icon = g.selected ? "✅" : "⬜";
        // V1.250: Usar Array.from() para fatiar nomes com emojis sem quebrar UTF-8
        const safeName = Array.from(g.name || "Sem Nome").slice(0, 22).join('');
        return [Markup.button.callback(`${icon} ${safeName}`, `wa_mass_grp_toggle_${instId}_${g.id}`)];
    });

    // Paginação
    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback("⬅️ Ant", `wa_mass_grp_page_${instId}_${page - 1}`));
    if (page < totalPages - 1) navRow.push(Markup.button.callback("Prox ➡️", `wa_mass_grp_page_${instId}_${page + 1}`));

    if (navRow.length > 0) buttons.push(navRow);

    // Ações Finais
    const selectedCount = groups.filter(g => g.selected).length;

    buttons.push([
        Markup.button.callback(`Seleção: ${selectedCount}`, "noop"),
        Markup.button.callback(selectedCount > 0 ? "🚀 Confirmar" : "⚠️ Selecione...", selectedCount > 0 ? `wa_mass_grp_confirm_${instId}` : "noop")
    ]);

    buttons.push([Markup.button.callback("🔙 Voltar", `wa_mass_init_${instId}`)]);

    const msgText = `📂 <b>Seleção de Grupos</b>\n\nTotal encontrados: ${groups.length}\nSelecionados: ${selectedCount}\n\nMarque os grupos para disparar:`;

    // Tentar editar, se falhar (ex: imagem antiga), enviar nova
    try {
        await ctx.editMessageText(msgText, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
    } catch {
        await ctx.reply(msgText, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
    }
}

bot.action(/^wa_mass_grp_toggle_(.+)_(.+)$/, async (ctx) => {
    // safeAnswer(ctx); // Pode causar "flash" em listas longas, opcional
    const instId = ctx.match[1];
    const grpId = ctx.match[2];

    const session = await getSession(ctx.chat.id);
    if (!session.temp_groups) return;

    const group = session.temp_groups.find(g => g.id === grpId);
    if (group) {
        group.selected = !group.selected;
        await syncSession(ctx, session);
        await renderGroupSelection(ctx, instId);
    } else {
        ctx.answerCbQuery("Grupo não encontrado na sessão.");
    }
});

bot.action(/^wa_mass_grp_page_(.+)_(.+)$/, async (ctx) => {
    const instId = ctx.match[1];
    const page = parseInt(ctx.match[2]);
    const session = await getSession(ctx.chat.id);
    session.temp_groups_page = page;
    await syncSession(ctx, session);
    await renderGroupSelection(ctx, instId);
});

bot.action(/^wa_mass_grp_confirm_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    const session = await getSession(ctx.chat.id);

    const selected = session.temp_groups.filter(g => g.selected);
    if (selected.length === 0) return ctx.answerCbQuery("Selecione pelo menos um grupo!");

    // O formato esperado pelo runCampaign é { name, phone } ou apenas string phone
    // Vamos converter para o formato padrão de contatos
    session.mass_contacts = selected.map(g => ({ name: g.name, phone: g.id }));

    // Avança para o estágio de mensagem (mesmo do txt)
    session.stage = `WA_WAITING_MASS_MSG_${instId}`;
    await syncSession(ctx, session);

    // Limpar temp groups da sessão (opcional, para economizar espaço)
    delete session.temp_groups;
    delete session.temp_groups_page;
    await syncSession(ctx, session);

    ctx.reply(`✅ *${selected.length} grupos selecionados!*\n\nAgora, envie o **conteúdo** que deseja disparar (Texto, Foto, Vídeo, etc):`, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", `wa_mass_groups_fetch_${instId}`)]])
    });
});


bot.action(/^wa_mass_list_paused_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, instId);
    if (!inst) return;

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
    const { inst, session } = await checkOwnership(ctx, data.inst_id);
    if (!inst) return;

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

        try {
            campaign.currentIndex = i;
            const contact = campaign.contacts[i];
            const rawPhone = typeof contact === 'string' ? contact : contact.phone;
            const nameFallback = "amigo(a)";
            const contactName = (typeof contact === 'object' && contact.name) ? contact.name : nameFallback;

            const phone = rawPhone.replace(/\D/g, "");
            const isGroupNode = rawPhone.includes("@g.us");
            const finalPhone = isGroupNode ? rawPhone : phone;

            if (!finalPhone) continue;

            const variations = campaign.messages || [campaign.message];
            let chosenMsg = variations[Math.floor(Math.random() * variations.length)];

            const hr = new Date().getHours();
            const saudacao = hr < 12 ? "Bom dia" : hr < 18 ? "Boa tarde" : "Boa noite";
            const emjs = ["😊", "👋", "🚀", "✨", "✅", "📍", "🤝", "🙌"];
            const randomEmoji = emjs[Math.floor(Math.random() * emjs.length)];

            chosenMsg = chosenMsg
                .replace(/\{\{nome\}\}/gi, contactName)
                .replace(/\{\{name\}\}/gi, contactName)
                .replace(/\{\{saudacao\}\}/gi, saudacao)
                .replace(/\{\{greet\}\}/gi, saudacao)
                .replace(/\{\{emoji\}\}/gi, randomEmoji);

            let jid = null;
            if (phone.includes("@g.us") || rawPhone.includes("@g.us")) {
                jid = rawPhone;
            }

            if (!jid) {
                const check = await callWuzapi("/user/check", "POST", { Phone: [phone] }, instId);
                if (check.success && check.data && check.data.Users && check.data.Users[0].IsInWhatsapp) {
                    jid = check.data.Users[0].JID;
                }
            }

            if (jid) {
                const body = { Phone: jid };
                let endpoint = "/chat/send/text";

                if (campaign.mediaType === 'text') {
                    body.Body = chosenMsg;
                } else {
                    if (chosenMsg) body.Caption = chosenMsg;
                    if (campaign.mediaType === 'photo') {
                        endpoint = "/chat/send/image";
                        body.Image = campaign.mediaData || campaign.mediaUrl;
                    } else if (campaign.mediaType === 'video') {
                        endpoint = "/chat/send/video";
                        body.Video = campaign.mediaData || campaign.mediaUrl;
                    } else if (campaign.mediaType === 'audio') {
                        endpoint = "/chat/send/audio";
                        body.Audio = campaign.mediaData || campaign.mediaUrl;
                    } else if (campaign.mediaType === 'document') {
                        endpoint = "/chat/send/document";
                        body.Document = campaign.mediaData || campaign.mediaUrl;
                        body.FileName = campaign.fileName || "arquivo";
                    }
                }

                log(`[DISPARO] Enviando ${campaign.mediaType} para ${phone}`);
                const result = await callWuzapi(endpoint, "POST", body, instId);

                if (result.success) {
                    campaign.current++;
                    if (!campaign.successNumbers) campaign.successNumbers = [];
                    campaign.successNumbers.push(phone);
                } else {
                    if (!campaign.failedNumbers) campaign.failedNumbers = [];
                    campaign.failedNumbers.push(phone);
                    log(`[DISPARO] ❌ Erro ao enviar para ${phone}: ${JSON.stringify(result)}`);
                }
            }

            // Progresso e Persistência
            if ((i + 1) % 5 === 0 || (i + 1) === campaign.total) {
                if (campaign.lastMsgId) {
                    try { await bot.telegram.deleteMessage(chatId, campaign.lastMsgId); } catch (e) { }
                }

                if (campaign.dbId) {
                    await supabase.from('scheduled_campaigns').update({
                        campaign_data: { ...campaign, currentIndex: i + 1, current: campaign.current }
                    }).eq('id', campaign.dbId);
                }

                const pct = Math.round(((i + 1) / campaign.total) * 100);
                const filled = "🟩".repeat(Math.floor(pct / 10));
                const empty = "⬜".repeat(10 - Math.floor(pct / 10));

                const lastMsg = `🚀 *Progresso do Disparo*\n\n${filled}${empty} ${pct}%\n\n📊 *Status:* ${i + 1} de ${campaign.total}\n✅ *Sucesso:* ${campaign.current}\n📱 *Instância:* \`${instId}\``;
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
                await new Promise(r => setTimeout(r, d));
            }
        } catch (e) {
            log(`[DISPARO ERR] Falha no índice ${i}: ${e.message}`);
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

// Handlers para Agendamento / Envio Agora
bot.action(/^(wa_mass_now_|wa_mass_confirm_start_)(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[2];
    const { inst, session } = await checkOwnership(ctx, instId);
    if (!inst) return;

    if (!session.mass_contacts || session.mass_contacts.length === 0) {
        return ctx.reply("❌ Nenhum contato encontrado para o disparo. Por favor, envie o arquivo novamente.");
    }
    if (!session.mass_msgs || session.mass_msgs.length === 0) {
        return ctx.reply("❌ Nenhuma mensagem configurada para o disparo.");
    }

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
    const { inst, session } = await checkOwnership(ctx, instId);
    if (!inst) return;

    session.stage = `WA_WAITING_MASS_SCHEDULE_${instId}`;
    await syncSession(ctx, session);

    ctx.editMessageText("📅 *Agendamento de Disparo*\n\nPor favor, envie a **data e hora** desejada no formato: `DD/MM/AAAA HH:MM`.\n\nExemplo: `15/02/2026 14:30`", { parse_mode: "Markdown" });
});

bot.action(/^wa_set_ai_prompt_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    const currentPrompt = inst?.ai_prompt || "🤖 Você é um assistente virtual prestativo.";

    session.stage = `WA_WAITING_AI_PROMPT_${id}`;
    await syncSession(ctx, session);

    // Escapar caracteres HTML para evitar quebra de parsing
    const escapedPrompt = currentPrompt
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const message = `📝 <b>System Prompt (Instruções)</b>\n\n📌 <b>Conteúdo Atual:</b>\n<pre>${escapedPrompt}</pre>\n\nPara alterar, envie o novo texto abaixo:`;

    try {
        if (message.length > 4096) {
            await ctx.reply("📝 *System Prompt (Instruções)*\n\n⚠️ O prompt atual é muito longo para exibição formatada. Aqui está ele como texto simples:", { parse_mode: "Markdown" });
            await ctx.reply(currentPrompt);
            return ctx.reply("Para alterar, envie o novo texto acima revisado ou novo texto:");
        }
        await ctx.reply(message, { parse_mode: "HTML" });
    } catch (e) {
        log(`[PROMPT EDIT ERR] ${e.message}`);
        await ctx.reply("📝 *System Prompt (Instruções)*\n\nPara alterar, envie o novo texto abaixo:", { parse_mode: "Markdown" });
        await ctx.reply(currentPrompt);
    }
});

bot.action(/^wa_set_ai_human_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    const currentThemes = inst?.ai_human_topics || "❌ Nenhum tema definido.";

    session.stage = `WA_WAITING_AI_HUMAN_${id}`;
    await syncSession(ctx, session);
    ctx.reply("🤝 *Temas para Transbordo Humano*\n\nListe quais assuntos ou situações a IA deve **parar** de responder e te chamar.\n\nExemplo:\n`Reclamações, negociação de valores, suporte técnico avançado ou quando o cliente expressar urgência crítica.`", { parse_mode: "Markdown" });
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
        `⏰ *Esperar:* \`${hours < 1 ? Math.round(hours * 60) + " minutos" : hours + " horas"}\`\n` +
        `🔢 *Máximo de Lembretes:* \`${maxNudges}\`\n` +
        `✉️ *Mensagens:* \n${msgs.map((m, i) => `${i + 1}. ${m}`).join("\n")}`;

    const buttons = [
        [Markup.button.callback(enabled ? "🔴 Desativar" : "🟢 Ativar", `wa_fu_toggle_${instId}`)],
        [Markup.button.callback("⏰ Definir Tempo (horas)", `wa_fu_set_hours_${instId}`)],
        [Markup.button.callback("🔢 Definir Qnt. Lembretes", `wa_fu_set_max_${instId}`)],
        [Markup.button.callback("📝 Prompt do Sistema", `wa_set_ai_prompt_${instId}`)],
        [Markup.button.callback("🔙 Voltar", `manage_${instId}`)]
    ];

    await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
}



bot.action(/^wa_ai_followup_menu_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    await renderFollowupMenu(ctx, id);
});

bot.action(/^wa_fu_toggle_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    inst.fu_enabled = !inst.fu_enabled;
    await syncSession(ctx, session);
    await renderFollowupMenu(ctx, id);
});

bot.action(/^wa_fu_set_hours_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;

    session.stage = `WA_WAITING_FU_HOURS_${id}`;
    await syncSession(ctx, session);

    const current = inst.fu_hours || 24;
    const label = current < 1 ? Math.round(current * 60) + "m" : current + "h";
    const msg = `⏰ Quanto tempo o robô deve esperar antes de cobrar o lead?\n\n` +
        `Exemplos: \`30m\`, \`1h\`, \`2h\`\n\n` +
        (current ? `📌 *Valor Atual:* _${label}_` : "");
    const buttons = current ? [[Markup.button.callback(`✅ Manter Atual`, `wa_ai_keep_fu_hours_${id}`)]] : [];

    ctx.reply(msg, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^wa_fu_set_max_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;

    session.stage = `WA_WAITING_FU_MAX_${id}`;
    await syncSession(ctx, session);

    const current = inst.fu_max || 1;
    const msg = `🔢 Quantos **lembretes** (cobranças) o robô deve enviar no máximo? (Ex: 3)` +
        (current ? `\n\n📌 *Valor Atual:* _${current}_` : "");
    const buttons = current ? [[Markup.button.callback(`✅ Manter Atual`, `wa_ai_keep_fu_max_${id}`)]] : [];

    ctx.reply(msg, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^wa_fu_set_msgs_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;

    session.stage = `WA_WAITING_FU_MSGS_${id}`;
    await syncSession(ctx, session);

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
    const { inst, session } = await checkOwnership(ctx, instId);
    if (!inst) return;
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
            bot.telegram.sendMessage(chatId, `✅ *WhatsApp Conectado com Sucesso!* \n\nA instância \`${instId}\` agora está online e pronta para uso no Connect.`, { parse_mode: "Markdown" });
        }
    }, 2000);

    activePolls.set(instId, interval);
}

bot.action(/^wa_qr_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    ctx.reply("⏳ Gerando QR Code...");

    await ensureWebhookSet(id);

    // Antes de gerar, verifica se já não está logado
    const stats = await callWuzapi("/session/status", "GET", null, id);
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
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;

    await ensureWebhookSet(id);

    // Antes de gerar, verifica se já não está logado
    const stats = await callWuzapi(`/session/status`, "GET", null, id);
    if (stats.success && (stats.data?.LoggedIn || stats.data?.loggedIn)) {
        return ctx.reply("✅ Você já está conectado!");
    }

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
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    await renderWebhookMenu(ctx, id);
});

// Handler unificado para configurar URL
bot.action(/^wa_set_web_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
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
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;

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
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
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
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
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
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;

    // Buscar status de presença atual (embora a API não retorne o estado, simulamos via sessão)
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
    const { inst, session } = await checkOwnership(ctx, id);
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
    const userPrompt = inst.ai_prompt || "Você é um assistente virtual prestativo.";
    const humanTopics = inst.ai_human_topics || "Não há temas específicos; tente ajudar o cliente o máximo possível.";
    const knowledgeBase = inst.ai_knowledge_base ? `\n# BASE DE CONHECIMENTO EXTRA (USE PARA RESPONDER)\n${inst.ai_knowledge_base}\n` : "";

    return `
# OBJETIVO E PERSONA
${userPrompt}
${knowledgeBase}

# MODO HUMANIZADO (HIGH-CONVERSION)
- Use gírias leves se o tom for amigável.
- Responda apenas o necessário. Nunca dê textos longos.
- ESPELHAMENTO SOCIAL: Reaja ao que o cliente diz (Ex: "Que legal!", "Entendo") antes de prosseguir.

# REGRAS DE OURO (NUNCA QUEBRE)
1. SAUDAÇÃO INTELIGENTE: Se apresente apenas na PRIMEIRA mensagem. Se o histórico já mostra que você falou oi, vá direto ao assunto.
2. ANTI-REPETIÇÃO (CRÍTICO): LEIA O HISTÓRICO. Se o cliente já respondeu, NÃO pergunte de novo. Assuma a resposta e avance.
3. PACIÊNCIA: Faça EXATAMENTE UMA pergunta por mensagem.

# TRANSBORDO HUMANO (CRÍTICO)
Se o cliente falar sobre os seguintes temas, use a tag [TRANSFERIR] imediatamente:
"${humanTopics}"

# QUALIFICAÇÃO DE LEADS (RODÍZIO)
Ao identificar que o cliente está pronto ou qualificado conforme seu objetivo, você DEVE incluir a tag [QUALIFICADO] no final da resposta. Isso é essencial para que o sistema funcione.

# FINALIZAÇÃO (Tags Obrigatórias)
- Para transbordo humano: use [TRANSFERIR]
- Para lead qualificado (pronto para venda/rodízio): use [QUALIFICADO]
`;
}

// --- Módulo AI SDR / Suporte ---
async function renderAiMenu(ctx, instId) {
    const session = await getSession(ctx.chat.id);
    const inst = session.whatsapp.instances.find(i => i.id === instId);
    if (!inst) return ctx.reply("❌ Instância não encontrada.");

    const isEnabled = inst.ai_enabled || false;
    const prompt = inst.ai_prompt || "🤖 Você é um assistente virtual prestativo.";
    const humanTopics = inst.ai_human_topics || "❌ Nenhum tema definido (IA tentará resolver tudo).";

    const text = `🤖 *Configuração de IA SDR (${instId})*\n\n` +
        `🔋 *Status:* ${isEnabled ? "✅ Ativado" : "❌ Desativado"}\n\n` +
        `📝 *Instruções (System Prompt):*\n\`${prompt.substring(0, 200)}${prompt.length > 200 ? "..." : ""}\`\n\n` +
        `🤝 *Temas para Humano:* \n_${humanTopics}_`;

    const buttons = [
        [Markup.button.callback(isEnabled ? "🔴 Desativar IA" : "🟢 Ativar IA", `wa_toggle_ai_${instId}`)],
        [Markup.button.callback("📝 Editar System Prompt", `wa_set_ai_prompt_${instId}`)],
        [Markup.button.callback("🤝 Temas para Humano", `wa_set_ai_human_${instId}`)],
        [Markup.button.callback("📚 Base de Conhecimento (PDF)", `wa_set_ai_knowledge_${instId}`)],
        [Markup.button.callback("⏱️ Tempo de Reativação", `wa_ai_resume_time_${instId}`)],
        [Markup.button.callback("🔔 Follow-ups", `wa_ai_followup_menu_${instId}`)],
        [Markup.button.callback("🔙 Voltar", `manage_${instId}`)]
    ];

    if (ctx.updateType === "callback_query") {
        await ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
    } else {
        await ctx.reply(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
    }
}

bot.action(/^wa_ai_menu_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    log(`[AI_MENU] Acesso ao menu principal ID: ${id}`);
    safeAnswer(ctx);
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    await ensureWebhookSet(id);
    await renderAiMenu(ctx, id);
});


bot.action(/^wa_toggle_ai_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    if (inst) {
        inst.ai_enabled = !inst.ai_enabled;
        await syncSession(ctx, session);
        await renderAiMenu(ctx, id);
    }
});



bot.action(/^wa_ai_keep_fu_(hours|max|msgs)_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[2];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    session.stage = "READY";
    await syncSession(ctx, session);
    await renderFollowupMenu(ctx, id);
});

bot.action(/^wa_ai_keep_resume_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    session.stage = "READY";
    await syncSession(ctx, session);
    await renderAiMenu(ctx, id);
});


bot.action(/^wa_ai_sync_web_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
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

bot.action(/^wa_set_ai_knowledge_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;

    session.stage = `WA_WAITING_AI_KNOWLEDGE_${id}`;
    await syncSession(ctx, session);

    const hasKnowledge = inst.ai_knowledge_base ? "✅ Já possui uma base ativa." : "❌ Nenhuma base configurada.";

    ctx.reply(`📚 *Base de Conhecimento (PDF)*\n\n${hasKnowledge}\n\nEnvie um arquivo **PDF** agora para treinar o robô com novas informações.\n\n_Dica: Envie tabelas de preços, manuais ou catálogos para respostas precisas._`, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🗑️ Limpar Base Atual", `wa_clear_ai_knowledge_${id}`)]])
    });
});

bot.action(/^wa_clear_ai_knowledge_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    if (inst) {
        inst.ai_knowledge_base = null;
        await syncSession(ctx, session);
        ctx.reply("🗑️ *Base de conhecimento removida!*");
        await renderAiMenu(ctx, id);
    }
});

bot.on('document', async (ctx, next) => {
    const session = await getSession(ctx.chat.id);
    if (!session.stage || !session.stage.startsWith("WA_WAITING_AI_KNOWLEDGE_")) return next();

    const instId = session.stage.split("WA_WAITING_AI_KNOWLEDGE_")[1];
    const doc = ctx.message.document;

    if (doc.mime_type !== 'application/pdf') {
        return ctx.reply("❌ Por favor, envie apenas arquivos no formato **PDF**.");
    }

    const loadingMsg = await ctx.reply("⏳ *Lendo e extraindo informações do PDF...*");

    try {
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const response = await fetch(fileLink);
        const buffer = await response.buffer();

        const parser = new PDFParse({ data: buffer });
        const data = await parser.getText();
        const text = data.text.replace(/\s+/g, ' ').trim();

        if (text.length < 10) {
            return ctx.editMessageText("⚠️ O PDF parece estar vazio ou não foi possível extrair o texto.");
        }

        const inst = session.whatsapp.instances.find(i => i.id === instId);
        if (inst) {
            inst.ai_knowledge_base = text.substring(0, 15000); // Limite de 15k caracteres
            session.stage = "READY";
            await syncSession(ctx, session);

            await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, `✅ *Conhecimento Atualizado!*\n\nExtraímos ${text.length} caracteres do documento. O robô já está pronto para usar essas informações.`);
            await renderAiMenu(ctx, instId);
        }
    } catch (e) {
        log(`[PDF ERR] ${e.message}`);
        ctx.editMessageText("❌ Ocorreu um erro ao processar o PDF. Verifique se o arquivo não está protegido por senha.");
    }
});

bot.action(/^wa_ai_resume_time_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, instId);
    if (!inst) return;

    session.stage = `WA_AI_RESUME_TIME_VAL_${instId}`;
    await syncSession(ctx, session);

    const current = inst.auto_resume_hours || 2;
    const msg = `⏱️ *Tempo de Reativação Automática*\n\n` +
        `Digite após quanto tempo de silêncio (inatividade humana) a IA deve voltar a responder esse lead.\n\n` +
        `💡 *Dica:* Você pode usar 'm' para minutos.\n\n` +
        `Exemplos:\n- \`30m\` (30 minutos)\n- \`1h\` ou \`1\` (1 hora)\n- \`24h\` (1 dia)\n\n` +
        (current ? `📌 *Valor Atual:* _${current}h_` : "");
    const buttons = current ? [[Markup.button.callback(`✅ Manter Atual`, `wa_ai_keep_resume_${instId}`)]] : [];

    ctx.reply(msg, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^wa_ai_resume_(.+)_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const tokenId = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, tokenId);
    if (!inst) return;
    const remoteJid = ctx.match[2];

    log(`[BOT] Retomando IA para ${remoteJid} na instância ${tokenId}`);

    // V1.242: Limpar pausa da sessão também
    if (session.whatsapp.pausedLeads) {
        delete session.whatsapp.pausedLeads[remoteJid];
        await saveSession(session.chat_id || ctx.chat.id, session);
    }

    try {
        await supabase.from("ai_leads_tracking")
            .update({ status: "RESPONDED", nudge_count: 0, last_interaction: new Date().toISOString() })
            .eq("chat_id", remoteJid).eq("instance_id", tokenId);
    } catch (e) { }

    ctx.editMessageText(`✅ *IA Retomada!*\nA partir da próxima mensagem, a IA responderá o cliente \`${remoteJid}\` novamente.`, { parse_mode: "Markdown" });
});

// --- Módulo de Rodízio de Corretores ---
async function renderBrokersMenu(ctx, instId) {
    const { inst } = await checkOwnership(ctx, instId);
    if (!inst) return;
    const { data: brokers } = await supabase.from("real_estate_brokers").select("*").eq("tg_chat_id", String(ctx.chat.id));

    let text = `👤 *Rodízio de Atendimento* (${instId})\n\n` +
        `Cadastre os atendentes/vendedores que participarão do rodízio de leads para esta instância.\n\n` +
        `📋 *Lista de Atendentes:* \n`;

    if (!brokers || brokers.length === 0) {
        text += "_Nenhum atendente cadastrado._";
    } else {
        brokers.forEach((b, i) => {
            text += `${i + 1}. *${b.name}* (${b.phone}) ${b.status === 'active' ? '🟢' : '🔴'}\n`;
        });
    }

    const isRotationOn = inst.rotation_enabled !== false;

    const buttons = [
        [Markup.button.callback(isRotationOn ? "🟢 Rodízio: ATIVADO" : "🔴 Rodízio: DESATIVADO", `wa_rotation_toggle_${instId}`)],
        [Markup.button.callback("➕ Adicionar Atendente", `wa_broker_add_${instId}`)],
        [Markup.button.callback("🗑️ Remover Atendente", `wa_broker_del_list_${instId}`)],
        [Markup.button.callback("🔙 Voltar", `manage_${instId}`)]
    ];

    await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
}

bot.action(/^wa_rotation_toggle_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    inst.rotation_enabled = !(inst.rotation_enabled !== false);
    await syncSession(ctx, session);
    await renderBrokersMenu(ctx, id);
});

bot.action(/^wa_brokers_menu_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst: ownershipOk } = await checkOwnership(ctx, id);
    if (!ownershipOk) return;
    await renderBrokersMenu(ctx, id);
});

bot.action(/^wa_broker_add_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst, session } = await checkOwnership(ctx, id);
    if (!inst) return;
    session.stage = `WA_BROKER_WAIT_NAME_${id}`;
    await syncSession(ctx, session);
    ctx.reply("📝 Digite o **NOME** do atendente/vendedor:");
});

bot.action(/^wa_broker_del_list_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst: ownershipOk } = await checkOwnership(ctx, id);
    if (!ownershipOk) return;
    const { data: brokers } = await supabase.from("real_estate_brokers").select("*").eq("tg_chat_id", String(ctx.chat.id));

    if (!brokers || brokers.length === 0) return ctx.answerCbQuery("❌ Nenhum corretor para remover.");

    const buttons = brokers.map(b => [Markup.button.callback(`❌ ${b.name}`, `wa_broker_confirm_del_${id}_${b.id}`)]);
    buttons.push([Markup.button.callback("🔙 Voltar", `wa_brokers_menu_${id}`)]);

    ctx.editMessageText("Escolha o corretor para **remover**:", Markup.inlineKeyboard(buttons));
});

bot.action(/^wa_broker_confirm_del_(.+)_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const instId = ctx.match[1];
    const { inst: ownershipOk } = await checkOwnership(ctx, instId);
    if (!ownershipOk) return;
    const brokerId = ctx.match[2];
    await supabase.from("real_estate_brokers").delete().eq("id", brokerId);
    ctx.answerCbQuery("✅ Corretor removido!");
    await renderBrokersMenu(ctx, instId);
});




// Função para processar IA (Suporta Texto, Áudio/Whisper e Histórico/Memória)
async function handleAiSdr({ text, audioBase64, history = [], systemPrompt, chatId, instanceId }) {
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

        // 2. Formatar Histórico (Priority: SUPABASE)
        const messages = [{ role: "system", content: systemPrompt }];

        // Buscar histórico no banco de dados
        const { data: dbHistory, error: dbErr } = await supabase
            .from("ai_chat_history")
            .select("role, content")
            .eq("chat_id", chatId)
            .eq("instance_id", instanceId)
            .order("created_at", { ascending: false })
            .limit(15);

        if (!dbErr && dbHistory && dbHistory.length > 0) {
            log(`[AI HISTORY] Recuperadas ${dbHistory.length} mensagens do Supabase para ${chatId}`);
            [...dbHistory].reverse().forEach(row => {
                messages.push({ role: row.role, content: row.content });
            });
        } else if (history && history.length > 0) {
            log(`[AI HISTORY] Usando histórico do Wuzapi como fallback.`);
            const sortedHistory = [...history].reverse().slice(-15);
            sortedHistory.forEach(msg => {
                const isMe = msg.from_me === true || msg.FromMe === true || (msg.sender_jid && msg.sender_jid.includes("me")) || (msg.Info?.FromMe === true);
                const role = isMe ? "assistant" : "user";
                const content = msg.text_content || msg.Body || msg.Message?.Conversation || msg.Message?.conversation || msg.Message?.extendedTextMessage?.text || "";
                if (content) messages.push({ role, content });
            });
        }

        // Salvar mensagem atual do usuário no banco
        if (userMessage) {
            await supabase.from("ai_chat_history").insert({
                chat_id: chatId,
                instance_id: instanceId,
                role: "user",
                content: userMessage
            });
            messages.push({ role: "user", content: userMessage });
        }

        // 3. Gerar resposta humanizada
        const response = await openai.chat.completions.create({
            model: DEFAULT_MODEL,
            messages: messages,
            temperature: 0.8,
            max_tokens: 250
        });

        const aiResponse = response.choices[0].message.content;
        log(`[AI SDR RAW] Resposta para ${chatId}: ${aiResponse.substring(0, 500)}`);

        // Salvar resposta da IA no histórico do banco
        if (aiResponse) {
            await supabase.from("ai_chat_history").insert({
                chat_id: chatId,
                instance_id: instanceId,
                role: "assistant",
                content: aiResponse
            });
        }

        return aiResponse;
    } catch (e) {
        log(`[ERR AI SDR] ${e.message}`);
        return null;
    }
}


// --- Módulo de Distribuição de Leads (Rodízio Round-Robin) ---
async function distributeLead(tgChatId, leadJid, instId, leadName, summary) {
    try {
        log(`[RODÍZIO] Buscando corretores para ${tgChatId}...`);
        const session = await getSession(tgChatId);
        const inst = session.whatsapp.instances.find(i => i.id === instId);
        const rotationEnabled = inst ? inst.rotation_enabled !== false : true;

        if (!rotationEnabled) {
            log(`[RODÍZIO] Rodízio desativado para ${instId}. Notificando apenas Telegram.`);
            const notifyText = `📢 *Novo Lead Qualificado (Rodízio OFF)*\n\n` +
                `👤 *Cliente:* ${leadName}\n` +
                `📱 *WhatsApp:* \`${leadJid.split('@')[0]}\`\n\n` +
                `📝 *Resumo/Motivo:* \n${summary}\n\n` +
                `⚠️ *Nota:* Como o rodízio está desativado, este lead **não** foi enviado para vendedores.`;

            await bot.telegram.sendMessage(tgChatId, notifyText, { parse_mode: "Markdown" });

            // Parar a IA para este contato mesmo assim
            await supabase.from("ai_leads_tracking")
                .update({ status: "TRANSFERRED", last_interaction: new Date().toISOString() })
                .eq("instance_id", instId)
                .eq("chat_id", leadJid);
            return;
        }

        const { data: brokers, error } = await supabase
            .from("real_estate_brokers")
            .select("*")
            .eq("tg_chat_id", String(tgChatId))
            .eq("status", "active");

        if (error || !brokers || brokers.length === 0) {
            log(`[RODÍZIO] Nenhum corretor ativo encontrado para ${tgChatId}. Notificando Telegram.`);
            bot.telegram.sendMessage(tgChatId, `⚠️ *Atenção:* O lead **${leadName}** foi qualificado, mas não há atendentes ativos para o rodízio.`);
            return;
        }
        let nextIndex = session.last_broker_index || 0;

        if (nextIndex >= brokers.length) nextIndex = 0;

        const broker = brokers[nextIndex];
        log(`[RODÍZIO] Encaminhando lead ${leadName} para ${broker.name} (${broker.phone})`);

        const msg = `🚀 *NOVO LEAD QUALIFICADO!* \n\n` +
            `👤 *Cliente:* ${leadName}\n` +
            `📱 *WhatsApp:* ${leadJid.split('@')[0]}\n\n` +
            `📝 *Resumo da IA:* \n${summary}\n\n` +
            `🔔 *Instância:* ${instId}\n` +
            `👉 *Ação:* Lead qualificado e entregue. A IA foi encerrada para este contato.`;

        // Marcar como TRANSFERRED para parar a IA para sempre
        await supabase.from("ai_leads_tracking")
            .update({ status: "TRANSFERRED", last_interaction: new Date().toISOString() })
            .eq("instance_id", instId)
            .eq("chat_id", leadJid); // Consistency: using chat_id instead of remote_jid if possible

        const rawPhone = broker.phone;
        const cleanPhone = rawPhone.replace(/\D/g, "");

        log(`[RODÍZIO] Validando número do broker no WhatsApp: ${cleanPhone}`);
        const checkRes = await callWuzapi("/user/check", "POST", { Phone: [cleanPhone] }, instId);

        let finalBrokerJid = null;
        if (checkRes.success && checkRes.data && checkRes.data.Users && checkRes.data.Users[0].IsInWhatsapp) {
            finalBrokerJid = checkRes.data.Users[0].JID;
            log(`[RODÍZIO] JID oficial encontrado: ${finalBrokerJid}`);
        } else {
            // Fallback para normalização manual caso o check falhe ou não encontre (para não travar o fluxo)
            const fallbackJid = cleanPhone.includes("@") ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;
            finalBrokerJid = normalizeJid(fallbackJid);
            log(`[RODÍZIO] ⚠️ /user/check falhou ou número não está no WA. Usando fallback: ${finalBrokerJid}`);
        }

        log(`[RODÍZIO] Enviando zap para broker: ${finalBrokerJid}`);
        const res = await callWuzapi("/chat/send/text", "POST", { Phone: finalBrokerJid, Body: msg }, instId);

        if (res && (res.success || res.code === 200)) {
            log(`[RODÍZIO] ✅ Notificação enviada com sucesso para ${broker.name}`);
        } else {
            log(`[RODÍZIO] ❌ FALHA ao notificar broker ${broker.name}: ${JSON.stringify(res)}`);
        }

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
    const { inst: ownershipOk } = await checkOwnership(ctx, id);
    if (!ownershipOk) return;
    const res = await callWuzapi(`/session/logout`, "POST", null, id);
    ctx.answerCbQuery(res.success ? "✅ Logout ok." : "❌ Falha no logout.");
    await renderManageMenu(ctx, id);
});

bot.action(/^wa_del_(.+)$/, async (ctx) => {
    safeAnswer(ctx);
    const id = ctx.match[1];
    const { inst: ownershipOk } = await checkOwnership(ctx, id);
    if (!ownershipOk) return;

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
        ctx.answerCbQuery("🗑️ Instância removida com sucesso!");
        return showInstances(ctx);
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
    const { inst: ownershipOk } = await checkOwnership(ctx, id);
    if (!ownershipOk) return;
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
    ctx.answerCbQuery("⏳ Gerando Pix...");
    const loadingMsg = await ctx.reply("⏳ Gerando seu pagamento Pix...");
    try {
        const config = await getSystemConfig();
        const res = await createSyncPayPix(ctx.chat.id, config.planPrice, ctx.from.first_name);
        try { await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (e) { }
        if (res.pix_code) {
            const qr = await QRCode.toBuffer(res.pix_code);
            await ctx.replyWithPhoto({ source: qr }, { caption: `💎 *Plano Pro*\n\nPIX:\n\`${res.pix_code}\``, parse_mode: "Markdown" });
        } else {
            ctx.reply("❌ Erro ao gerar pagamento. Tente novamente em instantes.");
        }
    } catch (e) {
        log(`[PIX_HANDLER_ERR] ${e.message}`);
        ctx.reply("❌ Erro inesperado ao gerar pagamento.");
    }
});

bot.on(["photo", "document", "video", "audio", "voice"], async (ctx, next) => {
    const session = await getSession(ctx.chat.id);
    if (!session.stage) return next();

    if (session.stage.startsWith("WA_FUNNEL_WAIT_BLOCK_MED_")) {
        const instId = session.stage.replace("WA_FUNNEL_WAIT_BLOCK_MED_", "");
        const msg = ctx.message;
        const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : (msg.document || msg.video || msg.audio || msg.voice).file_id;
        const fileLink = await bot.telegram.getFileLink(fileId);
        const caption = msg.caption || "";

        const { data: funnel } = await supabase.from("qualification_funnels").select("*").eq("instance_id", instId).maybeSingle();
        let blocks = funnel?.blocks || [];

        blocks.push({
            id: Date.now(),
            type: 'media',
            url: fileLink.href,
            caption,
            wait_for_reply: false,
            mime: msg.document?.mime_type || (msg.photo ? 'image/jpeg' : 'application/octet-stream')
        });

        await supabase.from("qualification_funnels").upsert({ instance_id: instId, blocks }, { onConflict: "instance_id" });
        ctx.reply("✅ Bloco de mídia adicionado com sucesso!");
        session.stage = "READY";
        await syncSession(ctx, session);
        return renderFunnelBlocksMenu(ctx, instId);
    }

    return next();
});


bot.on("text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const session = await getSession(ctx.chat.id);

    // Função de limpeza de mensagens para manter o chat limpo
    const cleanup = async () => {
        try { await ctx.deleteMessage(); } catch (e) { } // Deleta a mensagem do usuário (comando ou texto)
    };

    // --- FUNNEL CONFIG STAGES (MODULAR) ---
    if (session.stage && session.stage.startsWith("WA_FUNNEL_WAIT_BLOCK_")) {
        const parts = session.stage.split("_");
        const instId = parts[parts.length - 1];

        const { data: funnel } = await supabase.from("qualification_funnels").select("*").eq("instance_id", instId).maybeSingle();
        let blocks = funnel?.blocks || [];

        if (session.stage.includes("WAIT_BLOCK_TXT")) {
            const text = ctx.message.text.trim();
            blocks.push({ id: Date.now(), type: 'text', text, wait_for_reply: false });
            await supabase.from("qualification_funnels").upsert({ instance_id: instId, blocks, name: `Funil ${instId}` }, { onConflict: "instance_id" });
            ctx.reply("✅ Bloco de texto adicionado!");
        }

        if (session.stage.includes("WAIT_BLOCK_QUES")) {
            const text = ctx.message.text.trim();
            // Pergunta é um bloco de texto que espera resposta
            blocks.push({ id: Date.now(), type: 'wait', text, wait_for_reply: true, field: `campo_${blocks.length + 1}` });
            await supabase.from("qualification_funnels").upsert({ instance_id: instId, blocks, name: `Funil ${instId}` }, { onConflict: "instance_id" });
            ctx.reply("✅ Bloco de coleta adicionado!");
        }

        if (session.stage.includes("WAIT_BLOCK_DELAY")) {
            const delay = parseInt(ctx.message.text.trim());
            if (isNaN(delay)) return ctx.reply("❌ Digite um número válido em segundos.");
            blocks.push({ id: Date.now(), type: 'delay', delay });
            await supabase.from("qualification_funnels").upsert({ instance_id: instId, blocks, name: `Funil ${instId}` }, { onConflict: "instance_id" });
            ctx.reply("✅ Bloco de delay adicionado!");
        }

        session.stage = "READY";
        await syncSession(ctx, session);
        return renderFunnelBlocksMenu(ctx, instId);
    }

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

        if (session.stage === "ADMIN_WAIT_SUPPORT") {
            const link = ctx.message.text.trim();
            if (!link) return ctx.reply("❌ Link inválido.");
            config.supportLink = link;
            await saveSystemConfig(config);
            ctx.reply(`✅ Link de suporte atualizado para: **${link}**`);
            session.stage = "READY";
            await syncSession(ctx, session);
            return renderAdminPanel(ctx);
        }

        if (session.stage === "ADMIN_WAIT_TUTORIAL") {
            const link = ctx.message.text.trim();
            if (!link) return ctx.reply("❌ Link inválido.");
            config.tutorialLink = link;
            await saveSystemConfig(config);
            ctx.reply(`✅ Link de tutoriais atualizado para: **${link}**`);
            session.stage = "READY";
            await syncSession(ctx, session);
            return renderAdminPanel(ctx);
        }

        if (session.stage === "ADMIN_WAIT_WITHDRAW_PIX") {
            const pixKey = ctx.message.text.trim();
            const aff = session.affiliate || { balance: 0 };
            const amount = aff.balance;

            if (amount < 10) {
                return ctx.reply("❌ Saldo insuficiente para saque.");
            }

            // Notifica o Admin
            if (config.adminChatId) {
                const adminMsg = `🚨 *Nova Solicitação de Saque*\n\n` +
                    `👤 Usuário: \`${ctx.chat.id}\` (@${ctx.from.username || "sem_user"})\n` +
                    `💰 Valor: **R$ ${amount.toFixed(2)}**\n` +
                    `🔑 Chave PIX: \`${pixKey}\`\n\n` +
                    `_Por favor, realize o pagamento manual e avise o usuário._`;

                try {
                    await bot.telegram.sendMessage(config.adminChatId, adminMsg, { parse_mode: "Markdown" });
                } catch (e) {
                    log(`[ERR NOTIFY ADMIN] ${e.message}`);
                }
            }

            // Zera o saldo e salva
            aff.balance = 0;
            session.affiliate = aff;
            session.stage = "READY";
            await syncSession(ctx, session);

            ctx.reply("✅ *Solicitação Enviada!*\n\nSeu pedido de saque foi enviado para o administrador. Você receberá o pagamento em breve.", { parse_mode: "Markdown" });
            return renderAffiliateMenu(ctx);
        }

        if (session.stage === "ADMIN_WAIT_VIP_MANUAL") {
            const targetId = ctx.message.text.trim();
            log(`[ADMIN VIP] Tentando ativar/desativar VIP para: ${targetId}`);
            const s = await getSession(targetId);
            log(`[ADMIN VIP] Sessão atual do usuário - isVip: ${s.isVip}`);
            s.isVip = !s.isVip;
            if (s.isVip) {
                const exp = new Date(); exp.setDate(exp.getDate() + 30);
                s.subscriptionExpiry = exp.toISOString();
                log(`[ADMIN VIP] Ativando VIP até: ${s.subscriptionExpiry}`);
            } else {
                log(`[ADMIN VIP] Desativando VIP`);
            }
            await saveSession(targetId, s);
            log(`[ADMIN VIP] Sessão salva com sucesso - isVip: ${s.isVip}`);

            // Se o admin ativou a si mesmo, precisamos atualizar o objeto 'session' atual
            // para evitar que o syncSession(ctx, session) lá embaixo sobrescreva o banco com dados velhos.
            if (String(targetId) === String(ctx.chat.id)) {
                log("[ADMIN VIP] Admin ativou a si próprio. Sincronizando objetos de sessão...");
                Object.assign(session, s);
            }

            ctx.reply(`✅ Usuário \`${targetId}\` agora é: **${s.isVip ? "VIP" : "FREE"}**`, { parse_mode: "Markdown" });
            session.stage = "READY";
            await syncSession(ctx, session);
            return renderAdminPanel(ctx);
        }

        if (session.stage === "ADMIN_WAIT_USER_SEARCH") {
            const targetId = ctx.message.text.trim();
            // Validar se é número (opcional, mas bom pois ids são numéricos)
            if (!/^\d+$/.test(targetId)) return ctx.reply("❌ ID inválido. Digite apenas números.");

            session.stage = "READY";
            await syncSession(ctx, session);
            return renderUserDetails(ctx, targetId);
        }
        await syncSession(ctx, session);
        return renderAdminPanel(ctx);
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
                    [Markup.button.callback("📱 Minhas Instâncias", "cmd_instancias_menu")]
                ])
            });
            session.last_ui_id = sent.message_id;
            await syncSession(ctx, session);
        } else {
            ctx.reply("❌ Erro ao criar instância na API Wuzapi.");
        }
    } else if (session.stage && session.stage.startsWith("WA_BROKER_WAIT_NAME_")) {
        const instId = session.stage.replace("WA_BROKER_WAIT_NAME_", "");
        const { inst: ownershipOk } = await checkOwnership(ctx, instId);
        if (!ownershipOk) return;
        // Limite de corretores removido (Liberado)
        const name = ctx.message.text.trim();
        session.tempBroker = { name };
        session.stage = `WA_BROKER_WAIT_PHONE_${instId}`;
        await syncSession(ctx, session);
        return ctx.reply(`Ótimo! Agora digite o **WHATSAPP** do corretor ${name} (ex: 5511999999999):`);

    } else if (session.stage && session.stage.startsWith("WA_BROKER_WAIT_PHONE_")) {
        const instId = session.stage.replace("WA_BROKER_WAIT_PHONE_", "");
        const { inst: ownershipOk } = await checkOwnership(ctx, instId);
        if (!ownershipOk) return;

        let rawPhone = ctx.message.text.trim().replace(/\D/g, "");
        if (rawPhone.length < 8) return ctx.reply("❌ Número inválido. Digite um número real (ex: 5511999998888).");

        const loadingMsg = await ctx.reply("⏳ Validando número no WhatsApp...");

        // Chamada ao /user/check para validar e normalizar já no cadastro
        const checkRes = await callWuzapi("/user/check", "POST", { Phone: [rawPhone] }, instId);

        let finalPhone = rawPhone;
        if (checkRes.success && checkRes.data && checkRes.data.Users && checkRes.data.Users[0].IsInWhatsapp) {
            finalPhone = checkRes.data.Users[0].JID;
            log(`[BROKER_ADD] Número validado via API: ${finalPhone}`);
        } else {
            // Se o check falhar ou não achar, aplica o padrão manual mas avisa
            if (!finalPhone.includes("@")) finalPhone += "@s.whatsapp.net";
            finalPhone = normalizeJid(finalPhone);
            ctx.reply("⚠️ Não conseguimos confirmar este número no WhatsApp, mas vou salvá-lo como você digitou.");
        }

        const { error } = await supabase.from("real_estate_brokers").insert({
            name: session.tempBroker.name,
            phone: finalPhone,
            tg_chat_id: String(ctx.chat.id)
        });

        try { await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (e) { }

        if (error) {
            ctx.reply("❌ Erro ao salvar corretor no banco de dados.");
        } else {
            ctx.reply(`✅ Corretor **${session.tempBroker.name}** cadastrado com sucesso!`);
            session.stage = "READY";
            delete session.tempBroker;
            await syncSession(ctx, session);
            await renderBrokersMenu(ctx, instId);
        }
    } else if (session.stage && session.stage.startsWith("WA_AI_RESUME_TIME_VAL_")) {
        await cleanup();
        const instId = session.stage.replace("WA_AI_RESUME_TIME_VAL_", "");
        const inst = await checkOwnership(ctx, instId);
        if (!inst) return;
        let text = ctx.message.text.trim().toLowerCase();
        let val = 0;
        let label = "";

        if (text.endsWith("m") || text.endsWith("min")) {
            let mins = parseFloat(text.replace(/[^\d.]/g, ""));
            if (isNaN(mins)) return ctx.reply("❌ Digite um tempo válido (ex: 30m ou 1h).");
            val = mins / 60;
            label = `${mins} minutos`;
        } else {
            let hours = parseFloat(text.replace(/[^\d.]/g, ""));
            if (isNaN(hours)) return ctx.reply("❌ Digite um tempo válido (ex: 30m ou 1h).");
            val = hours;
            label = `${hours} hora(s)`;
        }

        if (val < 0.01) return ctx.reply("❌ O tempo mínimo é de 1 minuto.");

        inst.auto_resume_hours = val;
        await syncSession(ctx, session);
        const sent = await ctx.reply(`✅ *Tempo Atualizado:* A IA voltará a atender após **${label}** de silêncio humano.`);
        session.last_ui_id = sent.message_id;
        await syncSession(ctx, session);
        await renderAiMenu(ctx, instId);
        session.stage = "READY";
        await syncSession(ctx, session);
        return;

    } else if (session.stage && session.stage.startsWith("WA_WAITING_MASS_CONTACTS_")) {
        await cleanup();
        const instId = session.stage.replace("WA_WAITING_MASS_CONTACTS_", "");
        const { inst: ownershipOk } = await checkOwnership(ctx, instId);
        if (!ownershipOk) return;

        const lines = ctx.message.text.split("\n").map(n => n.trim()).filter(n => n.length > 5);
        const contacts = lines.map(line => {
            if (line.includes(";")) {
                const [name, phone] = line.split(";").map(p => p.trim());
                return { name, phone: phone.replace(/\D/g, "") };
            }
            return { name: null, phone: line.replace(/\D/g, "") };
        }).filter(c => c.phone.length >= 8);

        if (contacts.length === 0) return ctx.reply("❌ Nenhum número válido encontrado.\n\nEnvie os números (um por linha) no formato `Telefone` ou `Nome;Telefone`.\n\n💡 *Dica:* Você também pode enviar um **arquivo .txt** com a lista de contatos.");

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

        const sent = await ctx.reply(prompt, {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", `wa_mass_init_${instId}`)]])
        });

        session.last_ui_id = sent.message_id;
        await syncSession(ctx, session);

    } else if (session.stage && session.stage.startsWith("WA_WAITING_MASS_MSG_")) {
        const instId = session.stage.replace("WA_WAITING_MASS_MSG_", "");
        const { inst: ownershipOk } = await checkOwnership(ctx, instId);
        if (!ownershipOk) return;

        const rawMsg = ctx.message.text || "";
        const variations = rawMsg.split(";;;").map(v => v.trim()).filter(v => v.length > 0);

        session.mass_msgs = variations.length > 0 ? variations : [rawMsg];
        session.mass_media_type = 'text';
        session.stage = `WA_WAITING_MASS_DELAY_${instId}`;

        // Limpar prompt anterior e msg enviada
        if (session.last_ui_id) try { await ctx.telegram.deleteMessage(ctx.chat.id, session.last_ui_id); } catch (e) { }
        try { await ctx.deleteMessage(); } catch (e) { }

        const sent = await ctx.reply(`📝 ${session.mass_msgs.length} variações de mensagem salvas.\n\nAgora, defina o **intervalo de tempo** (delay) em segundos no formato \`MÍN-MÁX\`.\n\nExemplo: \`10-30\`.`, {
            ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", `wa_mass_new_start_${instId}`)]])
        });

        session.last_ui_id = sent.message_id;
        await syncSession(ctx, session);

    } else if (session.stage && session.stage.startsWith("WA_WAITING_MASS_DELAY_")) {
        const instId = session.stage.replace("WA_WAITING_MASS_DELAY_", "");
        const { inst: ownershipOk } = await checkOwnership(ctx, instId);
        if (!ownershipOk) return;
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
        const { inst: ownershipOk } = await checkOwnership(ctx, instId);
        if (!ownershipOk) return;
        const dateStr = ctx.message.text.trim();

        // Regex simples para DD/MM/AAAA HH:MM
        const reg = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
        const match = dateStr.match(reg);

        if (!match) return ctx.reply("❌ Formato inválido. Use `DD/MM/AAAA HH:MM`.");

        const [_, d, m, y, h, min] = match;
        // Força o fuso horário de Brasília (UTC-3)
        const scheduledFor = new Date(`${y}-${m}-${d}T${h}:${min}:00-03:00`);

        const now = new Date();
        // Hora atual de Brasília para feedback
        const brtNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
        const serverTimeStr = brtNow.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const serverDateStr = brtNow.toLocaleDateString('pt-BR');

        if (isNaN(scheduledFor.getTime()) || scheduledFor < now) {
            return ctx.reply(`❌ *Data no passado!*\n\nHora Atual (Brasília): \`${serverDateStr} ${serverTimeStr}\`\nSua entrada: \`${dateStr}\`\n\nPor favor, envie um horário futuro.`, { parse_mode: "Markdown" });
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
        const { inst: ownershipOk } = await checkOwnership(ctx, instId);
        if (!ownershipOk) return;
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
        const { inst: ownershipOk } = await checkOwnership(ctx, instId);
        if (!ownershipOk) return;
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
        const inst = session.whatsapp.instances.find(i => i.id === instId);
        if (!inst) return ctx.reply("❌ Instância não encontrada.");
        const prompt = ctx.message.text.trim();
        inst.ai_prompt = prompt;
        session.stage = "READY";
        await syncSession(ctx, session);
        ctx.reply("✅ *Instruções da IA salvas com sucesso!*", { parse_mode: "Markdown" });
        await renderAiMenu(ctx, instId);
    } else if (session.stage && session.stage.startsWith("WA_WAITING_FU_HOURS_")) {
        const instId = session.stage.replace("WA_WAITING_FU_HOURS_", "");
        const { inst: ownershipOk } = await checkOwnership(ctx, instId);
        if (!ownershipOk) return;
        const text = ctx.message.text.toLowerCase().trim();
        let val = 0;
        let label = "";

        if (text.endsWith("m")) {
            let mins = parseFloat(text.replace("m", "").trim());
            if (isNaN(mins)) return ctx.reply("❌ Digite um tempo válido (ex: 30m ou 1h).");
            val = mins / 60;
            label = `${Math.round(mins)} minutos`;
        } else {
            let hours = parseFloat(text.replace("h", "").trim());
            if (isNaN(hours)) return ctx.reply("❌ Digite um tempo válido (ex: 30m ou 1h).");
            val = hours;
            label = `${hours} hora(s)`;
        }

        if (val < 0.01) return ctx.reply("❌ O tempo mínimo é de 1 minuto.");

        const inst = session.whatsapp.instances.find(i => i.id === instId);
        if (inst) {
            inst.fu_hours = val;
            session.stage = "READY";
            await syncSession(ctx, session);
            ctx.reply(`✅ Tempo de espera definido para **${label}**.`);
            await renderFollowupMenu(ctx, instId);
        }
    } else if (session.stage && session.stage.startsWith("WA_WAITING_FU_MAX_")) {
        const instId = session.stage.replace("WA_WAITING_FU_MAX_", "");
        const { inst: ownershipOk } = await checkOwnership(ctx, instId);
        if (!ownershipOk) return;
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
        const { inst: ownershipOk } = await checkOwnership(ctx, instId);
        if (!ownershipOk) return;
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
    } else if (session.stage && session.stage.startsWith("WA_WAITING_AI_HUMAN_")) {
        const instId = session.stage.replace("WA_WAITING_AI_HUMAN_", "");
        const { inst: ownershipOk } = await checkOwnership(ctx, instId);
        if (!ownershipOk) return;
        const topics = ctx.message.text.trim();
        const inst = session.whatsapp.instances.find(i => i.id === instId);
        if (inst) {
            inst.ai_human_topics = topics;
            session.stage = "READY";
            await syncSession(ctx, session);
            ctx.reply("✅ *Temas de transbordo humano salvos!*");
            await renderAiMenu(ctx, instId);
        }
    }
});

// Helper para processar mídias de massa
async function handleMassMedia(ctx, type, fileId, caption, fileName, fileSize) {
    const session = await getSession(ctx.chat.id);
    if (!session.stage) return;

    // Se estiver na etapa de contatos, só aceita documento .txt
    const isContactImport = session.stage.startsWith("WA_WAITING_MASS_CONTACTS_");
    const isMessageContent = session.stage.startsWith("WA_WAITING_MASS_MSG_");

    if (!isContactImport && !isMessageContent) return;

    const instId = session.stage.replace(isContactImport ? "WA_WAITING_MASS_CONTACTS_" : "WA_WAITING_MASS_MSG_", "");
    const { inst: ownershipOk } = await checkOwnership(ctx, instId);
    if (!ownershipOk) return;

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

        // --- NOVO: Suporte a arquivo .txt para contatos ---
        if (type === 'document' && (fileName?.toLowerCase().endsWith(".txt") || mimeType === 'text/plain')) {
            const content = buffer.toString('utf-8');
            const lines = content.split("\n").map(n => n.trim()).filter(n => n.length > 5);
            const contacts = lines.map(line => {
                if (line.includes(";")) {
                    const [name, phone] = line.split(";").map(p => p.trim());
                    return { name, phone: phone.replace(/\D/g, "") };
                }
                return { name: null, phone: line.replace(/\D/g, "") };
            }).filter(c => c.phone.length >= 8);

            if (contacts.length === 0) {
                try { await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch (e) { }
                return ctx.reply("❌ Nenhum número válido encontrado no arquivo .txt.\n\nCertifique-se de que os números estão um por linha.");
            }

            session.mass_contacts = contacts;
            session.stage = `WA_WAITING_MASS_MSG_${instId}`;
            await syncSession(ctx, session);

            try { await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch (e) { }

            const prompt = `✅ *${contacts.length} contatos importados do arquivo!*\n\n` +
                `Agora, envie o **conteúdo** que deseja disparar (Texto, Foto, Vídeo, etc):`;
            const sent = await ctx.reply(prompt, {
                parse_mode: "Markdown",
                ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", `wa_mass_init_${instId}`)]])
            });
            session.last_ui_id = sent.message_id;
            await syncSession(ctx, session);
            return;
        }
        // --- FIM Suporte .txt ---

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

bot.on("photo", async (ctx) => handleMassMedia(ctx, 'photo', ctx.message.photo[ctx.message.photo.length - 1].file_id, ctx.message.caption, null, ctx.message.photo[ctx.message.photo.length - 1].file_size));
bot.on("video", async (ctx) => handleMassMedia(ctx, 'video', ctx.message.video.file_id, ctx.message.caption, ctx.message.video.file_name, ctx.message.video.file_size));
bot.on("audio", async (ctx) => handleMassMedia(ctx, 'audio', ctx.message.audio.file_id, ctx.message.caption, ctx.message.audio.file_name, ctx.message.audio.file_size));
bot.on("voice", async (ctx) => handleMassMedia(ctx, 'audio', ctx.message.voice.file_id, ctx.message.caption, "audio.ogg", ctx.message.voice.file_size));
bot.on("document", async (ctx) => handleMassMedia(ctx, 'document', ctx.message.document.file_id, ctx.message.caption, ctx.message.document.file_name, ctx.message.document.file_size));

// -- Server Endpoints --
app.get("/health", (req, res) => res.json({ status: "ok", version: SERVER_VERSION }));

// 🌐 Servir Dashboard Web (Lovable)
const DASHBOARD_DIST = path.join(__dirname, "dashboard", "dist");
app.use(express.static(DASHBOARD_DIST));

// Roteamento SPA: redireciona todas as rotas não-API para o index.html do dashboard
app.get(/^\/(?!webhook|health|uploads|static).*/, (req, res) => {
    res.sendFile(path.join(DASHBOARD_DIST, "index.html"));
});

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

// Endpoint para forçar refresh do código via Git
app.get("/webhook/force-refresh", async (req, res) => {
    log("🚀 [REFRESH] Iniciando force refresh via webhook...");
    try {
        const { execSync } = await import('child_process');

        log("📥 [REFRESH] Executando git pull...");
        const pullOutput = execSync('git pull origin main --force').toString();
        log(`[REFRESH] Resultado Git: ${pullOutput}`);

        log("📦 [REFRESH] Instalando dependências...");
        execSync('npm install --production');

        res.send(`<h1>✅ Refresh Concluído!</h1><pre>${pullOutput}</pre><p>Reiniciando processo...</p>`);

        log("🔄 [REFRESH] Reiniciando servidor em 2 segundos...");
        setTimeout(() => {
            process.exit(0); // O Docker/PM2 vai reiniciar o container com o código novo
        }, 2000);

    } catch (error) {
        log(`❌ [REFRESH] Erro ao atualizar: ${error.message}`);
        res.status(500).send(`<h1>❌ Erro ao atualizar</h1><pre>${error.message}</pre>`);
    }
});

app.post("/webhook", async (req, res) => {
    const body = req.body || {};
    log(`[WEBHOOK IN] Recebido corpo: ${JSON.stringify(body).substring(0, 2000)}`);

    // -- 1. Tratar Webhook SyncPay (Pagamento) --
    if (body.external_id && (body.status === "paid" || body.status === "confirmed")) {
        const chatId = body.external_id;
        const config = await getSystemConfig();
        const s = await getSession(chatId);

        // Se já era VIP, talvez seja renovação. Comissão geralmente é na primeira venda ou em todas?
        // Vou implementar crédito de comissão se houver padrinho e for primeira conversão (ou simplificar para cada pagamento confirmado)
        if (s.referredBy) {
            const refId = s.referredBy;
            const referrer = await getSession(refId);
            const comm = config.referralCommission || 10.0;

            referrer.affiliate.balance = (referrer.affiliate.balance || 0) + comm;
            referrer.affiliate.totalEarned = (referrer.affiliate.totalEarned || 0) + comm;
            referrer.affiliate.conversionsCount = (referrer.affiliate.conversionsCount || 0) + 1;

            await saveSession(refId, referrer);
            log(`[AFFILIATE] Comissão de R$ ${comm} creditada para ${refId} por indicação de ${chatId}`);

            try {
                bot.telegram.sendMessage(refId, `💰 *Comissão Recebida!*\n\nParabéns! Um de seus indicados assinou e você ganhou **R$ ${comm.toFixed(2)}**. \n\nConsulte seu saldo no menu de Afiliados.`, { parse_mode: "Markdown" });
            } catch (e) { }
        }

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
                // V1.236+: Extração robusta de áudio (Previne erro 400 no Whisper)
                let audioBase64 = rawData.Audio || body.Audio || (info.Audio) || null;

                // Proteção Crítica: Se o que temos for uma URL do WhatsApp, o Whisper vai dar erro.
                if (audioBase64 && (typeof audioBase64 !== 'string' || audioBase64.startsWith("http") || audioBase64.startsWith("/"))) {
                    log(`[WEBHOOK] Mídia recebida como URL/Path. Verificando se podemos baixar...`);
                    audioBase64 = null;
                }

                // V1.237: Download de áudio se for metadata do Wuzapi
                if (!audioBase64 && messageObj.audioMessage && (messageObj.audioMessage.url || messageObj.audioMessage.directPath)) {
                    try {
                        log(`[WEBHOOK] Baixando áudio do Wuzapi...`);
                        const downloadResp = await callWuzapi("/chat/downloadaudio", "POST", {
                            Url: messageObj.audioMessage.url || "",
                            DirectPath: messageObj.audioMessage.directPath || "",
                            MediaKey: messageObj.audioMessage.mediaKey || "",
                            Mimetype: messageObj.audioMessage.mimetype || "audio/ogg",
                            FileEncSHA256: messageObj.audioMessage.fileEncSha256 || "",
                            FileSHA256: messageObj.audioMessage.fileSha256 || "",
                            FileLength: messageObj.audioMessage.fileLength || 0
                        }, tokenId);

                        if (downloadResp && downloadResp.success && downloadResp.data && downloadResp.data.Data) {
                            audioBase64 = downloadResp.data.Data;
                            log(`[WEBHOOK] Áudio baixado com sucesso (${audioBase64.length} bytes).`);
                        } else {
                            log(`[WEBHOOK FAIL] Falha ao baixar áudio: ${JSON.stringify(downloadResp).substring(0, 100)}`);
                        }
                    } catch (e) {
                        log(`[WEBHOOK ERR] Erro ao baixar áudio: ${e.message}`);
                    }
                }

                log(`[WEBHOOK] Msg from: ${remoteJid} | Group: ${isGroup} | FromMe: ${isFromMe} | Text: ${text.substring(0, 50)}`);

                const isPrivate = remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@lid");
                if (isPrivate && !isGroup) {
                    let session;
                    try {
                        session = await getSession(chatId);
                    } catch (e) {
                        log(`[WEBHOOK ERR] Abortando processamento para evitar corrupção de sessão: ${e.message}`);
                        return res.send({ ok: true });
                    }
                    const inst = session.whatsapp.instances.find(i => i.id === tokenId);

                    if (isFromMe) {
                        // V1.233: Anti-Self-Pause logic
                        // Verificamos se a mensagem enviada foi a própria IA (evitando loop de pausa)
                        const { data: lastAiMsg } = await supabase
                            .from("ai_chat_history")
                            .select("content")
                            .eq("chat_id", remoteJid)
                            .eq("instance_id", tokenId)
                            .eq("role", "assistant")
                            .order("created_at", { ascending: false })
                            .limit(1)
                            .maybeSingle();

                        if (lastAiMsg && lastAiMsg.content === text) {
                            log(`[WEBHOOK] Ignorando eco da própria IA para ${remoteJid}`);
                            return res.send({ ok: true });
                        }

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

                    // Fallback para sessão se a tabela DB falhar ou não identificar o silenciamento
                    const isPausedInSession = session.whatsapp?.pausedLeads?.[remoteJid] === true;

                    if (isPausedInSession || (tracking && (tracking.status === "HUMAN_ACTIVE" || tracking.status === "TRANSFERRED"))) {
                        log(`[WEBHOOK] IA Pausada para ${remoteJid} (Status DB: ${tracking?.status || 'N/A'}, Sessão: ${isPausedInSession}).`);
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
                                        chatId: remoteJid,
                                        instanceId: tokenId
                                    });

                                    if (aiResponse) {
                                        let finalResponse = aiResponse
                                            .replace("[QUALIFICADO]", "")
                                            .replace("[TRANSFERIR]", "")
                                            .trim();

                                        if (aiResponse.includes("[TRANSFERIR]")) {
                                            const readableLead = `${pushName} (${(senderAlt || remoteJid).split('@')[0]})`;
                                            log(`[WEBHOOK AI] IA solicitou transbordo para ${readableLead}`);

                                            // V1.243: Processar notificações e updates em background para NÃO travar o envio da mensagem
                                            (async () => {
                                                try {
                                                    if (!session.whatsapp.pausedLeads) session.whatsapp.pausedLeads = {};
                                                    session.whatsapp.pausedLeads[remoteJid] = true;
                                                    await saveSession(chatId, session);

                                                    await supabase.from("ai_leads_tracking").upsert({
                                                        chat_id: remoteJid,
                                                        instance_id: tokenId,
                                                        status: "TRANSFERRED",
                                                        last_interaction: new Date().toISOString()
                                                    }, { onConflict: "chat_id, instance_id" });

                                                    const notifyText = `⚠️ *Solicitação de Atendimento Humano*\n\n` +
                                                        `O cliente **${readableLead}** na instância *${inst.name}* precisa de ajuda.\n\n` +
                                                        `A IA foi pausada no DB e na Sessão.`;
                                                    bot.telegram.sendMessage(chatId, notifyText, {
                                                        parse_mode: "Markdown",
                                                        ...Markup.inlineKeyboard([[Markup.button.callback("✅ Retomar IA", `wa_ai_resume_${tokenId}_${remoteJid}`)]])
                                                    });
                                                } catch (e) {
                                                    log(`[WEBHOOK AI ERR] Erro ao processar transbordo em background: ${e.message}`);
                                                }
                                            })();
                                        }
                                        if (aiResponse.includes("[QUALIFICADO]")) {
                                            const readableLead = `${pushName} (${(senderAlt || remoteJid).split('@')[0]})`;
                                            log(`[WEBHOOK AI] Lead Qualificado: ${readableLead}`);

                                            // Pausar IA para este lead (SDR finalizado)
                                            await supabase.from("ai_leads_tracking").update({ status: "TRANSFERRED" })
                                                .eq("chat_id", remoteJid).eq("instance_id", tokenId);

                                            log(`[AI QUALIFY] Notificando admin ${chatId} sobre lead ${readableLead}`);
                                            bot.telegram.sendMessage(chatId, `✅ *Lead Qualificado!* **${readableLead}**\n\nEncaminhando para o corretor da vez...`);

                                            // Trigger Rodízio Round-Robin com os dados capturados
                                            await distributeLead(chatId, remoteJid, tokenId, readableLead, finalResponse);
                                        }

                                        const chunks = finalResponse.split("\n\n").filter(c => c.trim().length > 0);
                                        for (const chunk of chunks) {
                                            const chunkIndex = chunks.indexOf(chunk);

                                            // V1.240: Delay de "pensamento" inicial ou entre blocos
                                            const thinkTime = chunkIndex === 0 ? 3000 : 1500;
                                            log(`[WEBHOOK AI] IA pensando por ${thinkTime}ms...`);
                                            await new Promise(r => setTimeout(r, thinkTime));

                                            // V1.240: Loop de presença para manter o "digitando..." ativo
                                            const typingDuration = Math.min(Math.max(chunk.length * 130, 4000), 12000);
                                            log(`[WEBHOOK AI] Simulando digitação (${chunk.length} chars) por ${typingDuration}ms...`);

                                            const startTime = Date.now();
                                            while (Date.now() - startTime < typingDuration) {
                                                try {
                                                    const pRes = await callWuzapi("/chat/presence", "POST", { Phone: remoteJid, State: "composing" }, tokenId);
                                                    // log(`[WEBHOOK AI] Presence: ${pRes.success ? 'OK' : 'FAIL'}`);
                                                } catch (e) { }
                                                // Espera 4 segundos antes de renovar o status (WP expira em ~10-15s)
                                                const remaining = typingDuration - (Date.now() - startTime);
                                                await new Promise(r => setTimeout(r, Math.min(remaining, 4000)));
                                            }

                                            const cRes = await callWuzapi("/chat/send/text", "POST", { Phone: remoteJid, Body: chunk.trim() }, tokenId);
                                            log(`[AI SEND] Resposta enviada para ${remoteJid}: ${cRes.success ? 'OK' : 'FALHA'}`);
                                        }

                                        // V1.239+: Atualizar tracking (Se não for transferência, marcar como AI_SENT)
                                        if (!aiResponse.includes("[TRANSFERIR]")) {
                                            try {
                                                await supabase.from("ai_leads_tracking").update({
                                                    last_interaction: new Date().toISOString(),
                                                    nudge_count: 0,
                                                    status: "AI_SENT"
                                                }).eq("chat_id", remoteJid).eq("instance_id", tokenId);
                                            } catch (e) {
                                                log(`[WEBHOOK AI ERR] Erro ao atualizar tracking (Tabela ai_leads_tracking pode estar ausente)`);
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



// --- Background Worker para Campanhas Agendadas ---


async function checkScheduledCampaigns() {
    try {
        const { data, error } = await supabase
            .from('scheduled_campaigns')
            .select('*')
            .or('status.eq.PENDING,status.eq.RUNNING'); // V1.251: Recuperar também as que pararam no meio

        if (error) throw error;

        for (const item of (data || [])) {
            // Se já estiver ativa em RAM, pular
            if (activeCampaigns.has(Number(item.chat_id))) continue;

            // Se for PENDING e tiver horário, respeitar o horário
            const nowIso = new Date().toISOString();
            if (item.status === 'PENDING' && item.scheduled_for > nowIso) continue;

            log(`[WORKER] Iniciando/Retomando campanha ${item.id} para ${item.chat_id} `);

            // Marcar como RUNNING no banco se ainda não estiver
            if (item.status === 'PENDING') {
                await supabase
                    .from('scheduled_campaigns')
                    .update({ status: 'RUNNING' })
                    .eq('id', item.id);
            }

            const c = item.campaign_data;
            const camp = {
                ...c,
                dbId: item.id,
                instId: item.inst_id,
                total: c.contacts.length,
                status: 'READY'
            };

            activeCampaigns.set(Number(item.chat_id), camp);

            // Avisar o usuário que retomou (se for RUNNING) ou iniciou (se for PENDING)
            const text = item.status === 'RUNNING' ? `🔄 *Retomando Disparo Interrompido*\n\nSua campanha para \`${item.inst_id}\` foi retomada a partir do contato ${camp.currentIndex + 1}.` : `⏰ *Agendamento Ativado!*\n\nIniciando agora o disparo para \`${item.inst_id}\`.`;

            try {
                await bot.telegram.sendMessage(item.chat_id, text, { parse_mode: "Markdown" });
            } catch (e) { }

            runCampaign(Number(item.chat_id), item.inst_id).then(async () => {
                await supabase.from('scheduled_campaigns').update({ status: 'COMPLETED' }).eq('id', item.id);
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
        // 1. Buscar apenas leads que estão aguardando o cliente (onde a IA ou o Nudge foi o último a falar)
        const { data: tracking, error } = await supabase
            .from("ai_leads_tracking")
            .select("*")
            .lt("nudge_count", 5)
            .or('status.eq.AI_SENT,status.eq.NUDGED'); // 🛑 Apenas se a última interação foi do bot

        if (error) {
            log(`[FU DEBUG] Erro ao buscar leads: ${error.message}`);
            return;
        }

        const leadsCount = (tracking || []).length;
        if (leadsCount > 0) log(`[FU DEBUG] Processando ${leadsCount} leads potenciais...`);

        for (const lead of (tracking || [])) {
            const parts = lead.instance_id.split("_");
            if (parts.length < 2) continue;
            const tgChatId = parts[1];

            const session = await getSession(tgChatId);

            // V1.245: Check de segurança defensivo
            if (!session?.whatsapp?.instances) continue;

            const inst = session.whatsapp.instances.find(i => i.id === lead.instance_id);

            if (!inst) {
                // log(`[FU DEBUG] Instância não encontrada para lead ${lead.chat_id}`);
                continue;
            }

            if (!inst.ai_enabled || !inst.fu_enabled) {
                // log(`[FU DEBUG] Follow-up ignorado: IA (${inst.ai_enabled}) ou FU (${inst.fu_enabled}) desativados.`);
                continue;
            }

            const now = new Date();
            const lastInteraction = new Date(lead.last_interaction);
            const diffHours = (now - lastInteraction) / (1000 * 60 * 60);
            const targetHours = inst.fu_hours || 24;

            // Log de depuração para leads que estão no radar mas ainda não bateram o tempo
            if (diffHours >= 0.01) { // Só logar se passou pelo menos 36 segundos para não saturar
                // log(`[FU DEBUG] Lead ${lead.chat_id} | Status: ${lead.status} | Diff: ${diffHours.toFixed(3)}h | Alvo: ${targetHours}h`);
            }

            if (diffHours >= targetHours && lead.nudge_count < (inst.fu_max || 1)) {
                const msgIndex = lead.nudge_count;
                const messages = inst.fu_msgs || ["Oi! Ainda está por aí?"];
                const messageToSend = messages[msgIndex] || messages[messages.length - 1];

                log(`[FOLLOW-UP] Enviando nudge ${lead.nudge_count + 1} para ${lead.chat_id} (Inst: ${lead.instance_id}) após ${diffHours.toFixed(1)}h`);

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



// --- Background Worker para Follow-ups do Funil ---
async function checkFunnelFollowups() {
    try {
        const { data: leads, error } = await supabase
            .from("funnel_leads_state")
            .select("*, qualification_funnels(final_action, presentation_text, questions)")
            .eq("status", "active");

        if (error || !leads) return;

        for (const lead of leads) {
            const parts = lead.instance_id.split("_");
            if (parts.length < 2) continue;
            const tgChatId = parts[1];

            const session = await getSession(tgChatId);
            const inst = session.whatsapp.instances.find(i => i.id === lead.instance_id);
            if (!inst) continue;

            const now = new Date();
            const lastInt = new Date(lead.last_interaction);
            const diffHours = (now - lastInt) / (1000 * 60 * 60);

            // Se o lead está inativo por mais de 4 horas (padrão para funil manual)
            if (diffHours >= 4) {
                log(`[FUNNEL-FU] Lead ${lead.remote_jid} inativo por ${diffHours.toFixed(1)}h. Notificando...`);

                // Marcar como 'dropped' para não processar mais
                await supabase.from("funnel_leads_state").update({ status: "dropped" }).eq("id", lead.id);

                const notifyText = `⚠️ *Lead Desistiu do Funil*\n\n` +
                    `O cliente \`${lead.remote_jid.split('@')[0]}\` parou de responder no meio do funil na instância *${inst.name}*.\n\n` +
                    `📝 *Dados Parciais:* \n${Object.entries(lead.answers || {}).map(([q, a]) => `*${q}:* ${a}`).join("\n") || "_Nenhum._"}`;

                bot.telegram.sendMessage(tgChatId, notifyText, { parse_mode: "Markdown" });
            }
        }
    } catch (e) {
        log(`[ERR FUNNEL-FU] ${e.message}`);
    }
}

// Iniciar worker de follow-up a cada 1 minuto (V1.235: mais rápido para follow-ups curtos)
setInterval(checkAiFollowups, 60000);
setInterval(checkFunnelFollowups, 600000); // Check every 10 min
setInterval(checkAutoResume, 600000); // Check every 10 min

bot.launch().then(() => {
    log("Bot Ativo");
    // Não executa imediatamente ao iniciar para evitar disparos acidentais se o fuso do servidor mudar
    setTimeout(checkScheduledCampaigns, 5000);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

app.listen(PORT, "0.0.0.0", () => {
    log(`Servidor rodando em: http://0.0.0.0:${PORT}`);
    const publicUrl = process.env.WEBHOOK_URL ? process.env.WEBHOOK_URL.replace("/webhook", "") : `http://localhost:${PORT}`;
    log(`Acesse via: ${publicUrl}/qr-client`);
});
