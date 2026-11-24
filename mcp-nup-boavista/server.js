#!/usr/bin/env node
// MCP server: consulta de NUP no Portal do Cidadão de Boa Vista/RR.
// O portal não tem API pública: o servidor abre a página num navegador headless,
// preenche o NUP, envia e devolve o que a página retornou (JSON de rede + texto).
//
// Transportes:
//   node server.js           -> stdio (Claude Desktop / Claude Code no seu PC)
//   node server.js --http    -> Streamable HTTP em /mcp (VPS no Brasil)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { chromium } from "playwright";
import http from "node:http";
import { z } from "zod";

const CFG = {
  url: process.env.NUP_URL || "https://cidadao.boavista.rr.gov.br/consulta-documentos-processos",
  inputSelector: process.env.NUP_INPUT_SELECTOR || "",   // ajuste fino, se a heurística errar
  submitSelector: process.env.NUP_SUBMIT_SELECTOR || "",
  timeoutMs: Number(process.env.NUP_TIMEOUT_MS || 45000),
  chromiumPath: process.env.CHROMIUM_PATH || undefined,
  headless: process.env.HEADFUL !== "1",
  port: Number(process.env.PORT || 8787),
  token: process.env.MCP_TOKEN || "",                    // exigido no modo --http
};

let browserPromise;
function getBrowser() {
  browserPromise ??= chromium.launch({ headless: CFG.headless, executablePath: CFG.chromiumPath });
  return browserPromise;
}

const CAPTCHA_RE = /recaptcha|hcaptcha|turnstile|captcha/i;
const SUBMIT_TEXT_RE = /consultar|pesquisar|buscar|localizar|enviar|filtrar/i;

async function findInput(page) {
  if (CFG.inputSelector) return page.locator(CFG.inputSelector).first();
  const handle = await page.evaluateHandle(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const inputs = [...document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])")]
      .filter(visible);
    const labelOf = (el) => {
      const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      return [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.getAttribute("formcontrolname"),
              lab?.textContent, el.closest("label")?.textContent].join(" ");
    };
    return inputs.find((el) => /nup|processo|protocolo|documento|n[uú]mero/i.test(labelOf(el))) || inputs[0] || null;
  });
  const el = handle.asElement();
  if (!el) throw new Error("Campo de NUP não encontrado na página. Rode diagnosticar_site e defina NUP_INPUT_SELECTOR.");
  return el;
}

async function submit(page, input) {
  if (CFG.submitSelector) return page.locator(CFG.submitSelector).first().click();
  const btn = page.locator("button, input[type=submit], a.btn").filter({ hasText: SUBMIT_TEXT_RE }).first();
  if (await btn.count()) return btn.click();
  const submitBtn = page.locator("button[type=submit], input[type=submit]").first();
  if (await submitBtn.count()) return submitBtn.click();
  return input.press("Enter");
}

function trimText(t, max = 15000) {
  t = (t || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? t.slice(0, max) + "\n…[truncado]" : t;
}

async function withPage(fn) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ locale: "pt-BR", timezoneId: "America/Boa_Vista" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(CFG.timeoutMs);
  try { return await fn(page); } finally { await ctx.close(); }
}

// "00000.0.013014/2026 (VOLUME 2)" -> nup "00000.0.013014/2026", volume "2"
export function normalizarNup(bruto) {
  const volume = bruto.match(/vol(?:ume)?\.?\s*(\d+)/i)?.[1];
  const nup = bruto.replace(/\(.*?\)/g, "").replace(/vol(?:ume)?\.?\s*\d+/i, "").trim();
  return { nup, volume };
}

async function selecionarOrgao(page, orgao) {
  if (!orgao) return null;
  const selects = page.locator("select:visible");
  for (let i = 0; i < await selects.count(); i++) {
    const sel = selects.nth(i);
    const opts = await sel.locator("option").evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));
    const alvo = opts.find((o) => new RegExp(`\\b${orgao}\\b`, "i").test(o.t) || o.v.toLowerCase() === orgao.toLowerCase());
    if (alvo) { await sel.selectOption(alvo.v); return alvo.t; }
  }
  return null; // portal sem seletor de órgão: segue só com o NUP
}

async function consultarNup(bruto, orgao) {
  const { nup, volume } = normalizarNup(bruto);
  return withPage(async (page) => {
    const api = [];
    page.on("response", async (res) => {
      const req = res.request();
      if (!["xhr", "fetch"].includes(req.resourceType())) return;
      const ct = res.headers()["content-type"] || "";
      let body = null;
      try { body = ct.includes("json") ? await res.json() : null; } catch {}
      api.push({ method: req.method(), url: res.url(), status: res.status(), postData: req.postData() || undefined, json: body });
    });

    await page.goto(CFG.url, { waitUntil: "networkidle" });
    const html = await page.content();
    const orgaoSelecionado = await selecionarOrgao(page, orgao);
    const input = await findInput(page);
    await input.fill("");
    await input.fill(nup);
    const before = api.length;
    await submit(page, input);
    await Promise.race([
      page.waitForLoadState("networkidle"),
      page.waitForTimeout(CFG.timeoutMs),
    ]);
    await page.waitForTimeout(1500); // SPAs renderizam depois da resposta

    const novas = api.slice(before).filter((r) => r.json !== null);
    const texto = trimText(await page.locator("main").first().innerText().catch(() => page.locator("body").innerText()));
    const semResultado = /n[aã]o (foi )?encontrad|nenhum (registro|resultado|processo)|inexistente|inv[aá]lid/i.test(texto);

    return {
      nup,
      volume,
      orgao: orgao || undefined,
      orgao_selecionado_no_portal: orgaoSelecionado || undefined,
      encontrado: !semResultado,
      captcha_detectado: CAPTCHA_RE.test(html) || undefined,
      respostas_api: novas.map(({ method, url, status, json }) => ({ method, url, status, json })),
      texto_pagina: texto,
      url_final: page.url(),
      consultado_em: new Date().toISOString(),
    };
  });
}

async function diagnosticar() {
  return withPage(async (page) => {
    const rede = [];
    page.on("request", (r) => { if (["xhr", "fetch", "script"].includes(r.resourceType())) rede.push(`${r.method()} ${r.url()}`); });
    await page.goto(CFG.url, { waitUntil: "networkidle" });
    const campos = await page.evaluate(() =>
      [...document.querySelectorAll("input, select, textarea, button")].map((e) => ({
        tag: e.tagName.toLowerCase(), type: e.type, name: e.name, id: e.id,
        placeholder: e.placeholder, texto: e.textContent?.trim().slice(0, 60),
      })));
    const html = await page.content();
    return { url: page.url(), titulo: await page.title(), captcha_detectado: CAPTCHA_RE.test(html), campos, rede };
  });
}

function buildServer() {
  const server = new McpServer({ name: "nup-boavista", version: "1.0.0" });

  server.registerTool("consultar_nup", {
    title: "Consultar NUP – Prefeitura de Boa Vista",
    description: "Consulta um processo/documento pelo NUP no Portal do Cidadão da Prefeitura de Boa Vista/RR e devolve situação, andamentos e demais dados exibidos pelo portal. Só leitura.",
    inputSchema: {
      nup: z.string().min(4).max(60).describe("NUP como está no protocolo. Ex.: 226812025, 00000.0.013014/2026, 24999/2026. Anotações como '(VOLUME 2)' são tratadas"),
      orgao: z.string().max(20).optional().describe("Sigla da secretaria dona do processo, ex.: SMAG, SMEC, SMCP"),
    },
  }, async ({ nup, orgao }) => {
    try {
      const r = await consultarNup(nup.trim(), orgao?.trim());
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Falha na consulta: ${e.message}` }] };
    }
  });

  server.registerTool("consultar_nups_em_lote", {
    title: "Consultar vários NUPs",
    description: "Consulta uma lista de NUPs em sequência (até 20) no portal de Boa Vista. Útil para acompanhar a carteira de processos.",
    inputSchema: {
      processos: z.array(z.object({ nup: z.string().min(4).max(60), orgao: z.string().max(20).optional() })).min(1).max(20),
    },
  }, async ({ processos }) => {
    const out = [];
    for (const p of processos) {
      try { out.push(await consultarNup(p.nup.trim(), p.orgao?.trim())); }
      catch (e) { out.push({ nup: p.nup, orgao: p.orgao, erro: e.message }); }
    }
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  server.registerTool("diagnosticar_site", {
    title: "Diagnosticar portal",
    description: "Abre o portal e lista campos do formulário, chamadas de rede e presença de captcha. Use quando consultar_nup falhar, para ajustar seletores.",
    inputSchema: {},
  }, async () => {
    try { return { content: [{ type: "text", text: JSON.stringify(await diagnosticar(), null, 2) }] }; }
    catch (e) { return { isError: true, content: [{ type: "text", text: `Falha: ${e.message}` }] }; }
  });

  return server;
}

async function main() {
  if (!process.argv.includes("--http")) {
    await buildServer().connect(new StdioServerTransport());
    return;
  }
  if (!CFG.token) { console.error("Defina MCP_TOKEN para rodar em modo --http."); process.exit(1); }
  http.createServer(async (req, res) => {
    if (!req.url.startsWith("/mcp")) { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== `Bearer ${CFG.token}`) { res.writeHead(401).end("unauthorized"); return; }
    // stateless: um servidor/transporte por requisição
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    let body = "";
    for await (const chunk of req) body += chunk;
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  }).listen(CFG.port, () => console.error(`MCP NUP Boa Vista em http://0.0.0.0:${CFG.port}/mcp`));
}

const shutdown = async () => { if (browserPromise) await (await browserPromise).close().catch(() => {}); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
if (!process.env.NUP_NO_MAIN) main().catch((e) => { console.error(e); process.exit(1); });
