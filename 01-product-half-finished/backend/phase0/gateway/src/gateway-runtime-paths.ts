// Deployment roots are shared with deploy/cloud/compose.yaml and its cloud.json template.
export const GATEWAY_CONFIG_ROOT = process.env.PAIOS_CONFIG_ROOT ?? '/etc/paios';
export const GATEWAY_DATA_ROOT = process.env.PAIOS_DATA_ROOT ?? '/var/lib/paios';
export const GATEWAY_SECRET_ROOT = process.env.PAIOS_SECRET_ROOT ?? '/run/secrets';
