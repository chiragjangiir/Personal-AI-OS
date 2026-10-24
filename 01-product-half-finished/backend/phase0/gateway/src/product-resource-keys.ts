/** The one list of mac-product.json product_resources keys: read by the production entrypoint and preserved by the
 *  provisioning tool, so a capability added to one can never be silently dropped by the other. */
export const PRODUCT_RESOURCE_KEYS = ['postgres', 'livekit_url', 'owner_policy_file', 'livekit_key_file', 'livekit_secret_file',
  'proxy_file', 'e2ee_file', 'pairing_file'] as const;
export const PRODUCT_RESOURCE_OPTIONAL_KEYS = ['errand_spool_dir', 'bark_device_file', 'bark_key_file', 'avatar_url', 'avatar_token_file', 'livekit_api_url', 'public_api_url', 'legacy_public_api_urls', 'gateway_host', 'gateway_port', 'staging_effect_sink_file', 'video_call', 'vidu_cleanup_key_file', 'call_rejoin_window_s', 'amap_key_file', 'ride_hr_alert_bpm', 'movement_pending_ttl_ms', 'avatar_looks'] as const;
