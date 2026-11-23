// Envio automático de lembretes de escala (e-mail via Gmail + WhatsApp via CallMeBot).
// Roda todo dia pelo GitHub Actions (.github/workflows/notificacoes.yml).
//
// Regras:
//  - Lembretes padrão: 7 e 3 dias antes (configurável no site: Notificações → ⚙️ Configurar).
//  - Cada lembrete é enviado UMA vez por escala e por responsável (fica registrado na escala).
//  - Se o robô não rodar num dia, ele envia no dia seguinte (janela entre um lembrete e o próximo).
//  - Escalas VAGO são ignoradas.
//
// Variáveis de ambiente:
//  GMAIL_USER, GMAIL_APP_PASSWORD   → conta que envia os e-mails
//  PREFIXO                          → "" (dados reais) ou "debug_" (dados de teste)
//  SIMULAR                          → "true" para só mostrar o que seria enviado

import nodemailer from 'nodemailer';

const PROJECT = 'escala-audio-bola-de-neve';
const API_KEY = 'AIzaSyCeArSQ8R9W8japktjIfdigLkWldcqTyF0'; // mesma chave pública usada no site
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const PREFIXO = process.env.PREFIXO || '';
const SIMULAR = process.env.SIMULAR === 'true';
const col = (n) => PREFIXO + n;

const CONFIG_PADRAO = {
    whatsappAtivo: true,
    emailAtivo: true,
    automaticoAtivo: true,
    lembretesDias: [7, 3],
    emailsCopia: '',
    assunto: 'Escala Áudio — {data} ({tipo})',
    link: 'https://vitorpantano.github.io/escala-audio/',
    mensagem: 'Olá {nome}! 🎧\n\nLembrete da escala do Ministério de Áudio:\n📅 {diaSemana}, {data} — {tipo}\n{titulo}\n\nConfirme sua presença em: {link}\n\nDeus abençoe! 🙌'
};

// ---------- Firestore (REST) ----------
const decode = (v) => {
    if (!v) return undefined;
    if ('stringValue' in v) return v.stringValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('nullValue' in v) return null;
    if ('timestampValue' in v) return v.timestampValue;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
    if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
    return undefined;
};
const decodeFields = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, decode(v)]));
const docToObj = (d) => ({ id: d.name.split('/').pop(), ...decodeFields(d.fields) });

async function fs(path, opts = {}) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${BASE}${path}${sep}key=${API_KEY}`, {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore ${res.status}: ${await res.text()}`);
    return res.json();
}

async function listar(colecao) {
    const out = [];
    let token = '';
    do {
        const r = await fs(`/${colecao}?pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
        (r?.documents || []).forEach(d => out.push(docToObj(d)));
        token = r?.nextPageToken || '';
    } while (token);
    return out;
}

async function escalasEntre(inicio, fim) {
    const r = await fs(':runQuery', {
        method: 'POST',
        body: JSON.stringify({
            structuredQuery: {
                from: [{ collectionId: col('escalas') }],
                where: {
                    compositeFilter: {
                        op: 'AND',
                        filters: [
                            { fieldFilter: { field: { fieldPath: 'data' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: inicio } } },
                            { fieldFilter: { field: { fieldPath: 'data' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: fim } } }
                        ]
                    }
                }
            }
        })
    });
    return (r || []).filter(x => x.document).map(x => docToObj(x.document));
}

async function marcar(id, campo, valor) {
    if (SIMULAR) return;
    await fs(`/${col('escalas')}/${id}?updateMask.fieldPaths=${campo}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: { [campo]: { stringValue: valor } } })
    });
}

// ---------- Datas (fuso de Sorocaba) ----------
const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()); // AAAA-MM-DD
const somarDias = (iso, n) => {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const diasEntre = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);

// ---------- Mensagem ----------
function montarTexto(modelo, escala, link) {
    const d = new Date(escala.data + 'T12:00:00Z');
    const vars = {
        nome: (escala.responsavel || '').split(' ')[0],
        data: d.toLocaleDateString('pt-BR', { timeZone: 'UTC' }),
        diaSemana: d.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'UTC' }),
        tipo: escala.tipo || '',
        titulo: escala.titulo || '',
        link: link || ''
    };
    return modelo.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)).replace(/\n{3,}/g, '\n\n').trim();
}
const cabecalho = (faltam) => faltam === 0 ? '⏰ Sua escala é HOJE!' : faltam === 1 ? '⏰ Sua escala é AMANHÃ!' : `⏰ Faltam ${faltam} dias para a sua escala!`;

// ---------- Envio ----------
const soDigitos = (t) => String(t || '').replace(/\D/g, '');
const numeroWhats = (tel) => { const d = soDigitos(tel); return d.length === 10 || d.length === 11 ? '55' + d : d; };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

let transporter;
async function enviarEmail(para, cc, assunto, texto) {
    if (SIMULAR) return;
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) throw new Error('Secrets GMAIL_USER / GMAIL_APP_PASSWORD não configurados');
    transporter ||= nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, '') }
    });
    await transporter.sendMail({
        from: `"Ministério de Áudio" <${process.env.GMAIL_USER}>`,
        to: para,
        cc: cc || undefined,
        subject: assunto,
        text: texto
    });
}

async function enviarWhats(telefone, apikey, texto) {
    if (SIMULAR) return;
    const url = `https://api.callmebot.com/whatsapp.php?phone=${numeroWhats(telefone)}&apikey=${encodeURIComponent(apikey)}&text=${encodeURIComponent(texto)}`;
    const res = await fetch(url);
    const corpo = await res.text();
    if (!res.ok || /invalid|error|not\s+(?:a\s+)?valid|blocked/i.test(corpo)) {
        throw new Error(`CallMeBot ${res.status}: ${corpo.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    }
    await esperar(4000); // o CallMeBot pede intervalo entre mensagens
}

// ---------- Principal ----------
async function main() {
    const cfgDoc = await fs(`/${col('config')}/notificacoes`);
    const config = { ...CONFIG_PADRAO, ...(cfgDoc ? decodeFields(cfgDoc.fields) : {}) };
    const dias = [...new Set((config.lembretesDias || []).map(Number).filter(n => n >= 0))].sort((a, b) => b - a);

    console.log(`Coleções: ${PREFIXO || '(reais)'} | Simulação: ${SIMULAR} | Lembretes: ${dias.join(', ')} dias`);
    if (!config.automaticoAtivo) { console.log('Envio automático desativado na configuração do site. Nada a fazer.'); return; }
    if (!dias.length) { console.log('Nenhum lembrete configurado.'); return; }

    const hoje = hojeSP();
    const escalas = (await escalasEntre(hoje, somarDias(hoje, dias[0]))).filter(e => e.responsavel && e.responsavel !== 'VAGO');
    const membros = await listar(col('membros'));
    const porNome = Object.fromEntries(membros.map(m => [m.nome, m]));
    const cc = String(config.emailsCopia || '').split(',').map(s => s.trim()).filter(Boolean).join(',');

    let enviados = 0, falhas = 0;
    for (const e of escalas.sort((a, b) => a.data.localeCompare(b.data))) {
        const faltam = diasEntre(hoje, e.data);
        // Lembrete "da vez": o menor N com faltam <= N (ex.: faltam 5 → lembrete de 7; faltam 2 → lembrete de 3)
        const n = [...dias].reverse().find(d => faltam <= d);
        if (n === undefined) continue;
        const m = porNome[e.responsavel] || {};
        const texto = `${cabecalho(faltam)}\n\n${montarTexto(config.mensagem, e, config.link)}`;
        const assunto = montarTexto(config.assunto, e, config.link);
        const rotulo = `${e.data} ${e.tipo} — ${e.responsavel} (lembrete ${n}d, faltam ${faltam})`;

        const canais = [
            {
                ativo: config.emailAtivo, campo: `autoEmail${n}d`, nome: 'E-mail',
                pronto: !!m.email, motivo: 'sem e-mail cadastrado',
                enviar: () => enviarEmail(m.email, cc, assunto, texto)
            },
            {
                ativo: config.whatsappAtivo, campo: `autoWhats${n}d`, nome: 'WhatsApp',
                pronto: !!(m.telefone && m.callmebotKey), motivo: m.telefone ? 'sem chave CallMeBot' : 'sem telefone',
                enviar: () => enviarWhats(m.telefone, m.callmebotKey, texto)
            }
        ];

        for (const c of canais) {
            if (!c.ativo) continue;
            if (e[c.campo] === e.responsavel) continue; // já enviado para este responsável
            if (!c.pronto) { console.log(`⚠️  ${c.nome} não enviado: ${rotulo} — ${c.motivo}`); continue; }
            try {
                await c.enviar();
                await marcar(e.id, c.campo, e.responsavel);
                enviados++;
                console.log(`✅ ${c.nome}${SIMULAR ? ' (simulado)' : ''}: ${rotulo}`);
            } catch (err) {
                falhas++;
                console.log(`❌ ${c.nome}: ${rotulo} — ${err.message}`);
            }
        }
    }
    console.log(`\nResumo: ${enviados} enviado(s), ${falhas} falha(s).`);
    if (falhas) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
