#!/usr/bin/env node
// Monitor diário dos processos da ASC no portal de Boa Vista.
// Consulta cada NUP de processos.json, compara com a última execução (estado.json)
// e envia e-mail só quando algo mudou ou quando a consulta falha.
//
//   node monitor.js            -> execução normal (agendar 1-2x por dia)
//   node monitor.js --resumo   -> envia o resumo completo mesmo sem mudança

import { consultarNup, fecharNavegador } from "./server.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import nodemailer from "nodemailer";

const DIR = new URL(".", import.meta.url);
const ARQ_PROCESSOS = new URL(process.env.PROCESSOS_FILE || "processos.json", DIR);
const ARQ_ESTADO = new URL(process.env.ESTADO_FILE || "estado.json", DIR);
const forcarResumo = process.argv.includes("--resumo");

const lerJson = async (u, padrao) => { try { return JSON.parse(await readFile(u, "utf8")); } catch { return padrao; } };

// Linhas de texto que aparentam ser situação/setor/andamento; o resto é ruído da página.
function destaques(texto) {
  return (texto || "").split("\n").map((l) => l.trim())
    .filter((l) => /situa|status|setor|local|tramit|andamento|unidade|despacho|movimenta|encaminh|arquiv|conclu|\d{2}\/\d{2}\/\d{4}/i.test(l))
    .slice(0, 12);
}

function impressaoDigital(r) {
  const base = r.respostas_api?.length ? JSON.stringify(r.respostas_api.map((a) => a.json)) : r.texto_pagina;
  return createHash("sha256").update(base || "").digest("hex");
}

async function enviar(assunto, corpo) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERTA_PARA, WEBHOOK_URL } = process.env;
  if (SMTP_HOST && ALERTA_PARA) {
    const t = nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT || 465), secure: Number(SMTP_PORT || 465) === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
    await t.sendMail({ from: SMTP_USER, to: ALERTA_PARA, subject: assunto, text: corpo });
  }
  if (WEBHOOK_URL) { // Slack, Teams, n8n, Make etc.
    await fetch(WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `*${assunto}*\n${corpo}` }) });
  }
  if (!(SMTP_HOST && ALERTA_PARA) && !WEBHOOK_URL) console.log(`\n=== ${assunto} ===\n${corpo}`);
}

async function main() {
  const processos = await lerJson(ARQ_PROCESSOS, []);
  const estado = await lerJson(ARQ_ESTADO, {});
  const mudancas = [], falhas = [], todos = [];

  for (const p of processos) {
    const chave = `${p.orgao || ""}|${p.nup}`;
    const nome = p.apelido || `${p.orgao || ""} ${p.nup}`.trim();
    try {
      const r = await consultarNup(p.nup, p.orgao);
      if (r.captcha_detectado) throw new Error("portal pediu captcha");
      const hash = impressaoDigital(r);
      const linhas = destaques(r.texto_pagina);
      const anterior = estado[chave];
      const bloco = `• ${nome} — NUP ${r.nup}${r.volume ? ` (vol. ${r.volume})` : ""}\n` +
        (r.encontrado ? linhas.map((l) => `    ${l}`).join("\n") || "    (sem detalhes legíveis; ver portal)" : "    NÃO ENCONTRADO no portal");
      todos.push(bloco);
      if (!anterior) mudancas.push(`[NOVO NO MONITOR]\n${bloco}`);
      else if (anterior.hash !== hash) {
        const antes = (anterior.destaques || []).map((l) => `    ${l}`).join("\n");
        mudancas.push(`[MUDOU desde ${anterior.verificado_em.slice(0, 16).replace("T", " ")}]\n${bloco}\n  Antes:\n${antes}`);
      }
      estado[chave] = { hash, destaques: linhas, encontrado: r.encontrado, verificado_em: r.consultado_em, mudou_em: anterior?.hash === hash ? anterior.mudou_em : r.consultado_em };
    } catch (e) {
      falhas.push(`• ${nome} — NUP ${p.nup}: ${e.message}`);
    }
  }
  await fecharNavegador();
  await writeFile(ARQ_ESTADO, JSON.stringify(estado, null, 2));

  const url = "https://cidadao.boavista.rr.gov.br/consulta-documentos-processos";
  if (mudancas.length || falhas.length) {
    const assunto = `[ASC] Processos PMBV: ${mudancas.length} mudança(s)${falhas.length ? `, ${falhas.length} falha(s)` : ""}`;
    const corpo = [mudancas.join("\n\n"), falhas.length ? `\nFalhas na consulta:\n${falhas.join("\n")}` : "", `\nPortal: ${url}`].join("\n");
    await enviar(assunto, corpo);
  } else if (forcarResumo) {
    await enviar(`[ASC] Processos PMBV: sem mudanças (${processos.length})`, `${todos.join("\n\n")}\n\nPortal: ${url}`);
  } else {
    console.log(`Sem mudanças em ${processos.length} processo(s).`);
  }
  process.exitCode = falhas.length === processos.length && processos.length ? 1 : 0;
}

main().catch(async (e) => { console.error(e); await fecharNavegador(); process.exit(1); });
