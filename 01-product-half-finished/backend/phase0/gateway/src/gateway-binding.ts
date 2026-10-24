// Single authority for the gateway loopback binding. Production is always 127.0.0.1:8787.
// Tests (node --test only) may relocate the port via PAIOS_GATEWAY_TEST_PORT so they never collide with a live gateway.
const override = process.env.NODE_TEST_CONTEXT ? Number(process.env.PAIOS_GATEWAY_TEST_PORT) : NaN;
export const GATEWAY_HOST = '127.0.0.1' as const;
export const GATEWAY_PORT: number = Number.isInteger(override) && override > 1024 && override < 65_536 && override !== 8787 ? override : 8787;
export const GATEWAY_HOST_HEADER = `${GATEWAY_HOST}:${GATEWAY_PORT}`;
