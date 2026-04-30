export const DEFAULT_OPENCLAW_CLI_PATH = '/opt/homebrew/bin/openclaw';

function normalizeOpenClawRoutes(routes: any) {
  return Array.isArray(routes) ? routes : [];
}

export function normalizeOpenClawConfig(config: any, mode: 'customer' | 'assistant') {
  const nested = mode === 'assistant' ? config.openclaw_assistant : config.openclaw_customer;
  const legacy = {
    enabled: config.openclaw_enabled,
    cli_path: config.openclaw_cli_path,
    timeout_seconds: config.openclaw_timeout_seconds,
    extra_prompt: config.openclaw_extra_prompt,
    routes: config.openclaw_routes,
  };
  const source = nested && typeof nested === 'object' ? nested : legacy;
  return {
    enabled: source.enabled ?? false,
    cli_path: source.cli_path || DEFAULT_OPENCLAW_CLI_PATH,
    timeout_seconds: source.timeout_seconds || 120,
    extra_prompt: source.extra_prompt || '',
    routes: normalizeOpenClawRoutes(source.routes),
  };
}

export function buildNestedConfig(config: any) {
  return {
    minimax: {
      api_key: config.minimax_api_key || '',
      group_id: config.minimax_group_id || '',
      vision_model: config.minimax_vision_model || 'MiniMax-VL-01',
      text_model: config.minimax_text_model || 'MiniMax-Text-01',
    },
    feishu: {
      webhook_url: config.feishu_webhook_url || '',
    },
    wechat: {
      enabled: config.wechat_enabled ?? true,
      window_title: '微信',
    },
    wecom: {
      enabled: config.wecom_enabled ?? true,
      window_title: '企业微信',
    },
    workflow_mode: config.workflow_mode || 'customer',
    mode: config.mode || 'auto',
    escalation: {
      keywords: config.escalation_keywords || '退款,投诉,经理,报警',
      max_unsolved_rounds: config.max_unsolved_rounds || 2,
    },
    reply_delay_min: config.reply_delay_min || 1,
    reply_delay_max: config.reply_delay_max || 3,
    ocr: {
      enabled: config.ocr_enabled ?? true,
      fast_mode: config.ocr_fast_mode ?? true,
      check_interval: config.ocr_check_interval || 3,
      guard_enabled: config.ocr_guard_enabled ?? false,
      guard_previous_check_interval: config.ocr_guard_previous_check_interval || 3,
      chat_region_mode: config.ocr_chat_region_mode || 'auto',
      chat_region: Array.isArray(config.ocr_chat_region) ? config.ocr_chat_region : [0.35, 0.0, 1.0, 1.0],
      languages: ['zh-Hans', 'en'],
      trigger_keywords: config.ocr_trigger_keywords || '',
    },
    openclaw: {
      customer: normalizeOpenClawConfig(config, 'customer'),
      assistant: normalizeOpenClawConfig(config, 'assistant'),
    },
  };
}
