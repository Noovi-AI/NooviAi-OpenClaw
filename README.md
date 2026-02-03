# NooviAI OpenClaw Fork

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>Fork com suporte a Portugues Brasileiro (PT-BR)</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://github.com/openclaw/openclaw"><img src="https://img.shields.io/badge/Upstream-OpenClaw-orange?style=for-the-badge" alt="Upstream"></a>
</p>

## Sobre este Fork

Este e um fork do [OpenClaw](https://github.com/openclaw/openclaw) mantido pela NooviAI. O projeto e mantido sincronizado com o repositorio oficial, adicionando apenas **suporte a internacionalizacao (i18n)** com traducoes para:

- **Ingles (EN)** - Idioma padrao
- **Portugues Brasileiro (PT-BR)** - Traducao completa

### O que foi alterado?

- Sistema de internacionalizacao (`src/i18n/`)
- Traducoes completas em EN e PT-BR (`src/i18n/locales/`)
- Instalador configurado para o dominio NooviAI

### O que NAO foi alterado?

Todo o resto do codigo permanece identico ao upstream. Funcionalidades, canais, ferramentas e configuracoes sao as mesmas do OpenClaw oficial.

---

## Instalacao

**Requisitos:** Node.js 22+

### Via NPM (do fork)

```bash
npm install -g git+https://github.com/Noovi-AI/NooviAi-OpenClaw.git

openclaw onboard --install-daemon
```

### Via Script de Instalacao

```bash
curl -fsSL https://nooviai.com/install.sh | bash
```

### Do Codigo Fonte

```bash
git clone https://github.com/Noovi-AI/NooviAi-OpenClaw.git
cd NooviAi-OpenClaw

pnpm install
pnpm build

pnpm openclaw onboard --install-daemon
```

---

## Inicio Rapido

```bash
# Executar o assistente de configuracao
openclaw onboard --install-daemon

# Iniciar o Gateway
openclaw gateway --port 18789 --verbose

# Enviar uma mensagem
openclaw message send --to +5511999999999 --message "Ola do OpenClaw"

# Conversar com o assistente
openclaw agent --message "Lista de tarefas" --thinking high
```

---

## Configuracao de Idioma

O idioma e detectado automaticamente pelo sistema. Para forcar um idioma especifico:

```bash
# Usar Portugues Brasileiro
LANG=pt_BR.UTF-8 openclaw onboard

# Usar Ingles
LANG=en_US.UTF-8 openclaw onboard
```

Ou configure no arquivo `~/.openclaw/openclaw.json`:

```json
{
  "locale": "pt"
}
```

---

## Canais Suportados

- WhatsApp (Baileys)
- Telegram
- Slack
- Discord
- Google Chat
- Signal
- iMessage
- Microsoft Teams
- Matrix
- WebChat

---

## Documentacao

Para documentacao completa, consulte a documentacao oficial do OpenClaw:

- [Documentacao Oficial](https://docs.openclaw.ai)
- [Getting Started](https://docs.openclaw.ai/start/getting-started)
- [Configuracao](https://docs.openclaw.ai/gateway/configuration)
- [Canais](https://docs.openclaw.ai/channels)
- [Seguranca](https://docs.openclaw.ai/gateway/security)

---

## Sincronizacao com Upstream

Este fork e regularmente sincronizado com o repositorio oficial do OpenClaw. As traducoes sao preservadas durante as atualizacoes.

Para verificar a versao atual:

```bash
openclaw --version
```

---

## Licenca

Este projeto e licenciado sob a [Licenca MIT](LICENSE), assim como o projeto original OpenClaw.

---

## Links

- [OpenClaw Oficial](https://github.com/openclaw/openclaw)
- [Documentacao OpenClaw](https://docs.openclaw.ai)
- [NooviAI](https://nooviai.com)
