import type {CapabilityRegistry} from './registry.ts';
import type {PackageContext, PackageFiles} from './interfaces.ts';

/** Mount under the existing authenticated internal gateway. Context comes from admission. */
export async function capabilityRegistryRoute(registry: CapabilityRegistry, context: PackageContext,
  action: 'find' | 'check' | 'publish' | 'rollback' | 'status' | 'monitor', body: any) {
  switch (action) {
    case 'find':
      if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 1000) throw new Error('query_invalid');
      return registry.find(context, body.query);
    case 'check': return body.candidate_id ? registry.checked(context, body.candidate_id) : registry.check(context, body.files as PackageFiles);
    case 'publish': return registry.publish(context, body.candidate_id);
    case 'rollback': return registry.rollback(context, body.name ?? '');
    case 'status': return registry.status(context, body.name ?? '', body.include_files === true);
    case 'monitor': return registry.monitor(context, body.name);
  }
}
