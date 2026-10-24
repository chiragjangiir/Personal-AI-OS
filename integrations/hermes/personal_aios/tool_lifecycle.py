"""Test and release native Hermes skills; pending writes and the native ledger own state."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory


def _native():
    from tools import skill_manager_tool, skill_ledger, write_approval
    return skill_manager_tool, skill_ledger, write_approval


def _files(root):
    if root is None:
        return {}
    root = Path(root)
    files = {}
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('Skill packages cannot contain symlinks')
        if path.is_file():
            files[path.relative_to(root).as_posix()] = path.read_text(encoding='utf-8')
    return files


def _operations(name, files, previous):
    first = {'action': 'patch', 'name': name, 'content': files['SKILL.md']} if previous else {
        'action': 'create', 'name': name, 'category': 'workshop', 'content': files['SKILL.md']}
    return [first] + [dict(action='write_file', name=name, file_path=p, file_content=c)
                      for p, c in sorted(files.items()) if p != 'SKILL.md'] + [
        dict(action='remove_file', name=name, file_path=p) for p in sorted(previous.keys() - files.keys())]


def _apply(payload):
    manager, _, _ = _native()
    result = json.loads(manager.apply_skill_pending(payload, package_release=True))
    if not result.get('success'):
        raise ValueError(result.get('error', str(result)))
    return result


def package_budget(files, previous=()):
    """One package policy for builder exports and native release candidates."""
    from tools.skill_manager_batch import _BATCH_MAX_OPS
    manager, _, _ = _native()
    metadata, _ = manager._parse_frontmatter(files['SKILL.md'])
    reason = metadata.get('budget_reason', '')
    reason = reason.strip() if isinstance(reason, str) else ''
    sizes = {path: len(content.encode('utf-8')) for path, content in files.items()}
    measurements = [('file_bytes', size, 131072, {'path': path}) for path, size in sizes.items()]
    measurements += [('file_count', len(files), 32, {}), ('total_bytes', sum(sizes.values()), 524288, {}),
                     ('atomic_operations', len(files) + len(set(previous) - files.keys()), _BATCH_MAX_OPS, {})]
    overruns = [dict(metric=metric, value=value, limit=limit, ratio=value / limit, **extra)
                for metric, value, limit, extra in measurements if value > limit]
    status = 'ready'
    if overruns and not reason:
        status = 'needs_reason'
    elif any(item['ratio'] > 2 for item in overruns):
        status = 'needs_approval'
    return {'status': status, 'overruns': overruns, 'reason': reason}


class ToolLifecycle:
    """The host supplies a trusted sandbox verifier: (registered_skill_dir) -> result dict.

    Calls operate on the current production profile. Build-home files are explicit inputs.
    Repair is another staged candidate; production remains available until promotion succeeds.
    """
    def __init__(self, verifier):
        self.verifier = verifier

    def _skill(self, name):
        manager, _, _ = _native()
        if error := manager._validate_name(name):
            raise ValueError(error)
        from hermes_constants import get_hermes_home
        expected = get_hermes_home().resolve() / 'skills' / 'workshop' / name
        skill = manager._find_skill(name)
        target = Path(skill['path']) if skill else manager._resolve_skill_dir(name, 'workshop')
        if target.resolve() != expected:
            raise ValueError('Lifecycle owns only skills in this profile skills/workshop directory')
        return target if skill else None

    def _pending(self, pending_id):
        import re
        _, _, approval = _native()
        if not re.fullmatch(r'[0-9a-f]{8}', pending_id):
            raise ValueError('Invalid candidate id')
        record = approval.get_pending(approval.SKILLS, pending_id)
        if not record or 'tool_candidate' not in record:
            raise ValueError('Unknown tool candidate')
        candidate = record['tool_candidate']
        expected = {'action': 'batch', 'operations': _operations(
            candidate['name'], candidate['files'], candidate['previous'])}
        if record['payload'] != expected:
            raise ValueError('Candidate payload changed; stage and pass testing again')
        return record

    def _save(self, record):
        from hermes_constants import get_hermes_home
        from utils import atomic_json_write
        atomic_json_write(get_hermes_home() / 'pending' / 'skills' / f"{record['id']}.json", record)

    def _outcome(self, record):
        budget = record['tool_candidate']['budget']
        return {'success': budget['status'] in {'ready', 'approved'}, 'status': budget['status'],
                'pending_id': record['id'], 'promoted': False, 'budget': budget}

    def _require_budget(self, record):
        status = record['tool_candidate'].get('budget', {}).get('status', 'ready')
        if status not in {'ready', 'approved'}:
            raise ValueError('Budget ' + status + ': this candidate requires the owner approval decision')

    def approve(self, pending_id):
        """The existing owner approval card grants only this immutable pending candidate."""
        from tools.approval_context import get_current_session_key
        from tools.approval import _gateway_notify_cb
        from tools.approval_gateway_wait import _await_gateway_decision
        import uuid
        record = self._pending(pending_id)
        manager, _, _ = _native()
        with manager._skill_mutation_lock(record['tool_candidate']['name']):
            record = self._pending(pending_id)
            budget = record['tool_candidate']['budget']
            if budget['status'] != 'needs_approval' or 'approval' in budget:
                return self._outcome(record)
            session = get_current_session_key()
            notify = _gateway_notify_cb(session)
            if notify is None:
                return self._outcome(record)
            request_id = uuid.uuid4().hex
            labels = {'file_bytes': '单文件字节', 'file_count': '文件数',
                      'total_bytes': '总字节', 'atomic_operations': '原子操作数'}
            details = '\n'.join(f"{labels[item['metric']]} {item.get('path', '')}: "
                                f"{item['value']}/{item['limit']}（{item['ratio']:g}倍）"
                                for item in budget['overruns'])
            question = f"工具 {record['tool_candidate']['name']} 本次超过两倍预算，是否继续？\n"
            question += details + '\n理由：' + budget['reason']
            answer = _await_gateway_decision(session, notify, {
                'request_id': request_id, 'command': f'Tool budget {pending_id}', 'description': question,
                'pattern_key': 'tool-budget:' + pending_id, 'allow_permanent': False, 'allow_session': False})
            budget['approval'] = {'request_id': request_id, **answer}
            if answer.get('resolved') and not answer.get('cancelled'):
                budget['status'] = 'approved' if answer['choice'] == 'once' else 'denied'
            self._save(record)
            return self._outcome(record)

    def stage(self, name, files, expected_previous=None):
        manager, _, approval = _native()
        root = self._skill(name)
        if not isinstance(files, dict) or 'SKILL.md' not in files:
            raise ValueError('Candidate requires SKILL.md and supporting text files')
        for path, content in files.items():
            if not isinstance(content, str):
                raise ValueError('Candidate files must be UTF-8 text')
            if error := manager._validate_file_path(path):
                raise ValueError(error)
        previous = _files(root)
        if expected_previous is not None and previous != expected_previous:
            raise ValueError('Production changed during build; rebuild from the current tool')
        operations = _operations(name, files, previous)
        budget = package_budget(files, previous)
        if budget['status'] == 'needs_reason':
            return {'success': False, 'status': budget['status'], 'budget': budget, 'promoted': False}
        record = approval.stage_write(approval.SKILLS, {'action': 'batch', 'operations': operations},
                                      summary=f'Tested tool candidate: {name}', origin=approval.current_origin())
        record['tool_candidate'] = {'name': name, 'files': files, 'previous': previous, 'budget': budget}
        self._save(record)
        return self._outcome(record)

    def test(self, pending_id):
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        manager, _, _ = _native()
        record = self._pending(pending_id)
        self._require_budget(record)
        candidate = record['tool_candidate']
        # Re-testing clears old evidence before executing any external verifier.
        record.pop('tool_test', None)
        self._save(record)
        metadata, _ = manager._parse_frontmatter(candidate['files']['SKILL.md'])
        modules = metadata.get('adapter_modules')
        error = None
        if not isinstance(modules, list) or any(not isinstance(path, str) for path in modules):
            error = 'SKILL.md must declare adapter_modules as a path list (use [] for pure business code)'
        else:
            for path in modules:
                if path not in candidate['files'] or path == 'SKILL.md':
                    error = f'Adapter module is not a supporting package file: {path}'
                    break
                lines = len(candidate['files'][path].splitlines())
                if lines > 200:
                    error = f'Adapter module {path} has {lines} lines; maximum is 200. Narrow the source contract.'
                    break
        if error:
            return {'success': False, 'pending_id': pending_id,
                    'verification': {'success': False, 'error': error}}
        with TemporaryDirectory(prefix='hermes-tool-test-') as home:
            token = set_hermes_home_override(home)
            try:
                _apply({'operations': _operations(candidate['name'], candidate['files'], {})})
                root = self._skill(candidate['name'])
                scan = manager.scan_skill(root, source='agent-created')
                allowed, reason = manager.should_allow_install(scan)
                if allowed is not True:
                    raise ValueError(f'Native security scan refused candidate: {reason}')
                result = self.verifier(root)
                if _files(root) != candidate['files']:
                    raise ValueError('Verifier changed candidate files; stage the modified candidate again')
            finally:
                reset_hermes_home_override(token)
        if not isinstance(result, dict) or result.get('success') is not True:
            return {'success': False, 'pending_id': pending_id, 'verification': result}
        record['tool_test'] = {'payload': record['payload'], 'candidate': candidate, 'result': result}
        self._save(record)
        return {'success': True, 'pending_id': pending_id, 'verification': result}

    def promote(self, pending_id):
        manager, ledger, approval = _native()
        record = self._pending(pending_id)
        self._require_budget(record)
        candidate, tested = record['tool_candidate'], record.get('tool_test', {})
        if tested.get('payload') != record['payload'] or tested.get('candidate') != candidate:
            raise ValueError('Candidate must pass testing before promotion')
        name = candidate['name']
        with manager._skill_mutation_lock(name):
            root = self._skill(name)
            if _files(root) != candidate['previous']:
                raise ValueError('Production changed since staging; stage a new candidate')
            before = ledger.capture_before(root)
            if before is None:
                raise ValueError('Native rollback ledger is unavailable')
            result = _apply(record['payload'])
            release_id = ledger.record_mutation('tool-release', name, before=before,
                after_root=self._skill(name), evidence={'pending_id': pending_id, 'verification': tested['result'],
                                                       'budget': candidate.get('budget')})
            if release_id is None:
                raise RuntimeError('Skill promoted but release ledger failed; native per-operation backups remain')
            approval.discard_pending(approval.SKILLS, pending_id)
        return {**result, 'release_id': release_id, 'name': name, 'budget': candidate.get('budget')}

    def monitor(self, name):
        root = self._skill(name)
        if root is None:
            raise ValueError('Skill is not installed')
        return {'name': name, 'verification': self.verifier(root), 'repair_action': 'stage'}

    def _active_release(self, name=''):
        from hermes_constants import get_hermes_home
        _, ledger, _ = _native()
        entries = ledger.list_entries(skill=name or None)
        reverted = {r['evidence']['release_id'] for r in entries if r['action'] == 'tool-revert'}
        workshop = get_hermes_home().resolve() / 'skills' / 'workshop'
        return next((r for r in entries if r['action'] == 'tool-release' and r['id'] not in reverted
                     and all(Path(i['path']).resolve().is_relative_to(workshop / r['skill'])
                             for i in r['before'] + r['after'])), None)

    def revert(self, name=''):
        manager, ledger, _ = _native()
        selected = self._active_release(name)
        if selected is None:
            raise ValueError('No active tool release to revert')
        name = selected['skill']
        with manager._skill_mutation_lock(name):
            root = self._skill(name)
            release = self._active_release(name)
            if release is None:
                raise ValueError('No active tool release to revert')
            if root is None:
                raise ValueError('Skill is not installed')
            previous = _files(root)
            before_paths = {item['path'] for item in release['before']}
            for item in release['after']:
                path = Path(item['path']).relative_to(root).as_posix()
                if previous.get(path, '').encode('utf-8') != ledger.read_blob(item['sha256']):
                    raise ValueError('Production changed after release; refusing to overwrite it')
                if item['path'] not in before_paths:
                    previous.pop(path, None)
            after_paths = {item['path'] for item in release['after']}
            for item in release['before']:
                path = Path(item['path']).relative_to(root).as_posix()
                if item['path'] not in after_paths and path in previous:
                    raise ValueError('Production changed after release; refusing to overwrite it')
                blob = ledger.read_blob(item['sha256'])
                if blob is None:
                    raise ValueError('Native rollback backup is missing')
                previous[path] = blob.decode('utf-8')
            if previous:
                result = _apply({'operations': _operations(name, previous, _files(root))})
            else:
                result = _apply({'action': 'delete', 'name': name})
            if ledger.record_mutation('tool-revert', name, after_root=self._skill(name),
                                      evidence={'release_id': release['id']}) is None:
                raise RuntimeError('Skill reverted but native release ledger failed')
            return {**result, 'reverted_release_id': release['id']}

    def status(self, name=''):
        _, ledger, approval = _native()
        selected = self._active_release(name)
        name = name or (selected['skill'] if selected else '')
        root = self._skill(name) if name else None
        return {'name': name, 'installed': root is not None, 'path': str(root) if root else None,
                'pending': [r['id'] for r in approval.list_pending(approval.SKILLS)
                            if r.get('tool_candidate', {}).get('name') == name],
                'releases': [r['id'] for r in ledger.list_entries(skill=name) if r['action'] == 'tool-release']}
