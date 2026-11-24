# MCP – Consulta de NUP (Prefeitura de Boa Vista/RR)

Servidor MCP que consulta processos e documentos pelo NUP no
[Portal do Cidadão](https://cidadao.boavista.rr.gov.br/consulta-documentos-processos).
O portal não tem API, então o servidor abre a página num Chrome invisível, preenche o NUP e
devolve o que o portal mostrou: as respostas JSON internas do site e o texto da tela.

**Precisa rodar numa máquina no Brasil.** O portal recusa conexões vindas de fora do país.
Servidores de nuvem nos EUA/Europa não conseguem acessar.

## Ferramentas (só leitura)

| Ferramenta | O que faz |
|---|---|
| `consultar_nup` | Consulta 1 NUP (+ sigla da secretaria, opcional): situação, setor, andamentos |
| `consultar_nups_em_lote` | Consulta até 20 pares NUP + secretaria em sequência (carteira de processos) |
| `diagnosticar_site` | Lista campos, chamadas de rede e se há captcha. Use quando a consulta falhar |

## Opção A — no seu PC (mais simples)

Requisito: Node.js 20 ou superior.

```bash
cd mcp-nup-boavista
npm install          # já baixa o Chromium
```

**Claude Code:**
```bash
claude mcp add nup-boavista -- node /CAMINHO/mcp-nup-boavista/server.js
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "nup-boavista": { "command": "node", "args": ["/CAMINHO/mcp-nup-boavista/server.js"] }
  }
}
```

Nesse modo funciona no Desktop e no Claude Code, mas não no app web nem no celular.

## Opção B — VPS no Brasil (uso pelo time)

Use uma VPS com IP brasileiro (por exemplo AWS `sa-east-1`, Oracle São Paulo, Magalu Cloud ou Locaweb).

```bash
npm install && npx playwright install-deps chromium
MCP_TOKEN=<token-forte> PORT=8787 npm run http
```

Coloque o servidor atrás de HTTPS (Caddy ou Nginx) e rode-o com pm2 ou systemd. Para conectar no Claude Code:

```bash
claude mcp add --transport http nup-boavista https://SEU-DOMINIO/mcp --header "Authorization: Bearer <token>"
```

## Formatos de NUP aceitos

Cada secretaria numera de um jeito e todos são aceitos como vêm no protocolo:
`226812025` (SMAG), `00000.0.013014/2026 (VOLUME 2)` (SMEC), `24999/2026` (SMCP).
Anotações como "(VOLUME 2)" são removidas antes da busca e devolvidas no campo `volume`.
Se o portal tiver um seletor de órgão, a sigla informada é escolhida nele automaticamente.

## Monitor diário dos processos da ASC

O `monitor.js` consulta os processos listados em `processos.json`. Ele guarda a última situação em `estado.json`
e manda alerta **só quando algum processo mudar** (situação, setor ou andamento) ou quando a consulta falhar.

```bash
node --env-file=.env monitor.js            # execução normal
node --env-file=.env monitor.js --resumo   # manda o resumo de todos, mesmo sem mudança (ex.: toda segunda)
```

Para incluir ou tirar processos, edite `processos.json` (campos `nup`, `orgao` e `apelido`).

**Alerta por e-mail:** copie `.env.example` para `.env` e preencha (destinatários: CEO e financeiro).
O `.env` fica só na máquina e não vai para o Git. As variáveis são:

```
SMTP_HOST=smtp.gmail.com  SMTP_PORT=465  SMTP_USER=alertas@...  SMTP_PASS=<senha de app>
ALERTA_PARA=financeiro@...,diretoria@...
WEBHOOK_URL=<opcional: Slack, Teams, n8n>
```

Sem SMTP nem webhook configurados, o alerta só aparece no terminal.

**Agendar (máquina no Brasil, ligada no horário):**
- Windows: Agendador de Tarefas → Criar tarefa básica → diariamente às 08:10 e às 14:10 →
  programa `node`, argumentos `--env-file=.env monitor.js`, iniciar em `C:\...\mcp-nup-boavista`.
- Linux/VPS (`crontab -e`):
  `10 8,14 * * 1-5 cd /opt/mcp-nup-boavista && node --env-file=.env monitor.js >> monitor.log 2>&1`

## Ajustes (variáveis de ambiente)

| Variável | Uso |
|---|---|
| `NUP_INPUT_SELECTOR` / `NUP_SUBMIT_SELECTOR` | Seletor CSS do campo e do botão, se a detecção automática errar |
| `NUP_TIMEOUT_MS` | Tempo máximo por consulta (padrão 45000) |
| `HEADFUL=1` | Abre o navegador visível, útil para depurar |
| `CHROMIUM_PATH` | Caminho de um Chrome/Chromium já instalado |

## Limitações

- Se o portal passar a exigir captcha, a ferramenta indica `captcha_detectado: true` e a consulta automática deixa de funcionar.
- Quando `diagnosticar_site` mostrar a chamada de API interna do portal, dá para trocar o navegador
  por uma chamada HTTP direta. A consulta fica cerca de 10 vezes mais rápida.
- Use com volume moderado. É um portal público e consultas em massa podem levar ao bloqueio do IP.
