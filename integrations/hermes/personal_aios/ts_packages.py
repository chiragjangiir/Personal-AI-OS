"""Project the manifest catalog onto the native provider during family migration."""


def legacy_schemas(schemas, package_tools):
    packaged = {name.rsplit('__', 1)[-1] for name in package_tools}
    if not any(schema['name'] in packaged for schema in schemas):
        return schemas
    from gateway.run_scope import current_scope
    # N12's restricted profiles still enforce native names; keep their allowlisted aliases.
    if current_scope() != 'owner':
        return schemas
    return [schema for schema in schemas if schema['name'] not in packaged]
