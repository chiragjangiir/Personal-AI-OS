import runpy
server = runpy.run_path('/package/server/server.py')
result = server['call']('sample', {})
assert result['structuredContent']['status']['state'] == 'succeeded'
assert result['structuredContent']['values'][0]['value'] == 1
assert len(result['content']) == 1
