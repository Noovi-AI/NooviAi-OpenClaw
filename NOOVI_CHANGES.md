# NooviAI OpenClaw Fork - Modificacoes

Este documento lista todas as modificacoes feitas no fork NooviAI em relacao ao upstream OpenClaw.

## Resumo

Este fork (`NooviAi-OpenClaw`) mantem customizacoes especificas para a NooviAI, incluindo:

- **i18n** - Sistema de internacionalizacao (Ingles e Portugues-BR)
- **WAHA** - Plugin para WhatsApp HTTP API
- **Instaladores** - Scripts de instalacao customizados

## Customizacoes Isoladas (Sem Conflito com Upstream)

Estas customizacoes vivem em diretorios/arquivos novos que nao existem no upstream:

| Diretorio/Arquivo | Descricao |
|-------------------|-----------|
| `extensions/waha/` | Plugin WAHA para WhatsApp HTTP API |
| `src/i18n/` | Sistema de internacionalizacao (CLI) |
| `src/i18n/locales/en.json` | Traducoes CLI em Ingles |
| `src/i18n/locales/pt.json` | Traducoes CLI em Portugues-BR |
| `ui/src/i18n/` | Sistema de internacionalizacao (Web UI) |
| `ui/src/i18n/locales/en.ts` | Traducoes Web UI em Ingles |
| `ui/src/i18n/locales/pt.ts` | Traducoes Web UI em Portugues-BR |
| `scripts/copy-i18n-locales.ts` | Script de build para copiar locales |
| `scripts/i18n-check.ts` | Verifica strings faltantes |
| `scripts/sync-upstream.sh` | Sincroniza com upstream |
| `NOOVI_CHANGES.md` | Este arquivo |

## Arquivos Upstream Modificados

Estas modificacoes alteram arquivos que existem no upstream e podem gerar conflitos durante merge:

| Arquivo | Tipo | Descricao |
|---------|------|-----------|
| `package.json` | build | Adicionado `dist/i18n/**` aos files, script de copy i18n |
| `src/wizard/onboarding.ts` | i18n | Strings extraidas para t() |
| `src/cli/program/help.ts` | i18n | Flag --language adicionada |
| `src/cli/program/preaction.ts` | i18n | Inicializacao do i18n |
| `src/cli/argv.ts` | i18n | Helper getLanguageFlag() |
| `src/config/types.openclaw.ts` | i18n | Tipo CliLanguage e campo language |
| `ui/src/main.ts` | i18n | Inicializacao do i18n |
| `ui/src/ui/navigation.ts` | i18n | Titulos traduzidos |

## Estrutura de Branches

```
main (Noovi)     <-- producao com todas as customizacoes
  |
  +-- upstream/main  <-- espelho do openclaw/openclaw (somente sync)
  |
  +-- feature/i18n   <-- desenvolvimento i18n
  +-- feature/waha   <-- ja mergido (extensions/waha)
  +-- feature/xxx    <-- futuras customizacoes
```

## Tags de Versao

Formato: `vYYYY.M.D-noovi.N`

Exemplos:
- `v2026.2.1-noovi.1` - Primeira release Noovi baseada em v2026.2.1
- `v2026.2.1-noovi.2` - Segunda release Noovi na mesma base

## Processo de Atualizacao do Upstream

1. **Buscar atualizacoes**
   ```bash
   git fetch upstream
   git log upstream/main --oneline -20
   ```

2. **Criar branch de merge**
   ```bash
   git checkout -b update/vYYYY.M.D main
   ```

3. **Merge com upstream**
   ```bash
   git merge upstream/main
   ```

4. **Resolver conflitos**
   - Consulte a tabela "Arquivos Upstream Modificados" acima
   - Mantenha as customizacoes Noovi
   - Integre mudancas do upstream

5. **Verificar strings novas**
   ```bash
   pnpm i18n:check  # (quando implementado)
   ```

6. **Traduzir strings faltantes**
   - Editar `src/i18n/locales/pt.json`

7. **Testar**
   ```bash
   pnpm build && pnpm test
   ```

8. **Merge para main**
   ```bash
   git checkout main
   git merge update/vYYYY.M.D
   ```

9. **Tag**
   ```bash
   git tag vYYYY.M.D-noovi.N
   ```

## Scripts de Manutencao

| Script | Descricao |
|--------|-----------|
| `scripts/sync-upstream.sh` | Sincroniza com upstream |
| `scripts/i18n-check.ts` | Verifica strings faltantes |
| `pnpm i18n:check` | Verifica completude das traducoes |
| `pnpm test src/i18n/` | Testa sistema i18n |

## Idiomas Suportados

| Codigo | Nome | Status |
|--------|------|--------|
| `en` | English | Completo (baseline) |
| `pt` | Portugues (Brasil) | Em progresso |

## Configuracao de Idioma

### CLI

O usuario pode configurar o idioma da CLI de 3 formas (em ordem de prioridade):

1. **Flag de linha de comando**: `openclaw --language pt onboard`
2. **Variavel de ambiente**: `OPENCLAW_LANGUAGE=pt`
3. **Deteccao automatica**: Usa `LANG` ou `LC_ALL` do sistema

### Web UI

O idioma da Web UI e configurado:

1. **localStorage**: Salvo em `openclaw-language`
2. **Deteccao automatica**: Usa `navigator.language` do navegador

## Contato

- **GitHub**: https://github.com/NooviAi/NooviAi-OpenClaw
- **Upstream**: https://github.com/openclaw/openclaw
