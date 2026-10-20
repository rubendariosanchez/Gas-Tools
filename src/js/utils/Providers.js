/**
 * @fileoverview Catálogo de proveedores de IA y los orígenes que requieren.
 *
 * Los hosts de los proveedores se declaran como `optional_host_permissions`
 * en el manifest; el popup los solicita/revoca bajo demanda con
 * `chrome.permissions`. Mantener sincronizado con el manifest.
 */

/** @type {Object<string, {label: string, origins: string[]}>} */
export const AI_PROVIDER_ORIGINS = Object.freeze({
    openai:     { label: 'OpenAI',                    origins: ['https://api.openai.com/*'] },
    anthropic:  { label: 'Anthropic',                 origins: ['https://api.anthropic.com/*'] },
    gemini:     { label: 'Google Gemini',             origins: ['https://generativelanguage.googleapis.com/*'] },
    openrouter: { label: 'OpenRouter',                origins: ['https://openrouter.ai/*'] },
    chatllm:    { label: 'Abacus ChatLLM',            origins: ['https://apps.abacus.ai/*'] },
    nvidia:     { label: 'NVIDIA',                    origins: ['https://integrate.api.nvidia.com/*'] },
    custom:     { label: 'Local (Ollama / LM Studio)', origins: ['http://localhost/*', 'http://127.0.0.1/*'] },
});
