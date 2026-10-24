#!/usr/bin/env python3
"""lego `exec` DNS-01 hook for Aliyun DNS (Alidns RPC API, stdlib only).

Called by lego as: alidns-hook.py present|cleanup <fqdn> <value>
Credentials come from ALICLOUD_ACCESS_KEY / ALICLOUD_SECRET_KEY in the environment (acme.sh sources the
root-only /srv/paios/acme/alidns.env). The Ubuntu lego build has no alidns provider, and Alidns only accepts
the Unicode name of an IDN zone, so the zone is matched on its PunyCode and addressed by its DomainName.
"""
import base64, datetime, hashlib, hmac, json, os, sys, urllib.error, urllib.parse, urllib.request, uuid

AK, SK = os.environ['ALICLOUD_ACCESS_KEY'], os.environ['ALICLOUD_SECRET_KEY']
TTL = int(os.environ.get('ALICLOUD_TTL', '600'))


def enc(s):
    return urllib.parse.quote(str(s), safe='-_.~')


def call(action, **params):
    p = {'Format': 'JSON', 'Version': '2015-01-09', 'AccessKeyId': AK, 'SignatureMethod': 'HMAC-SHA1',
         'Timestamp': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
         'SignatureVersion': '1.0', 'SignatureNonce': uuid.uuid4().hex, 'Action': action, **params}
    query = '&'.join(f'{enc(k)}={enc(p[k])}' for k in sorted(p))
    sig = hmac.new((SK + '&').encode(), ('GET&%2F&' + enc(query)).encode(), hashlib.sha1).digest()
    url = f'https://alidns.aliyuncs.com/?{query}&Signature={enc(base64.b64encode(sig).decode())}'
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        body = json.load(e)
    if 'Code' in body:
        sys.exit(f'alidns {action}: {body["Code"]} {body.get("Message", "")}')
    return body


def zone_for(name):
    page, zones = 1, []
    while True:
        r = call('DescribeDomains', PageNumber=page, PageSize=100)
        zones += r['Domains']['Domain']
        if page * 100 >= r['TotalCount']:
            break
        page += 1
    matches = [(z['DomainName'], (z.get('PunyCode') or z['DomainName']).lower()) for z in zones]
    matches = [m for m in matches if name == m[1] or name.endswith('.' + m[1])]
    if not matches:
        sys.exit(f'alidns: no hosted zone for {name}')
    return max(matches, key=lambda m: len(m[1]))


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ('present', 'cleanup'):
        sys.exit(f'usage: {sys.argv[0]} present|cleanup <fqdn> <value>')
    action, fqdn, value = sys.argv[1:]
    name = fqdn.rstrip('.').lower()
    zone, ace = zone_for(name)
    rr = name[:-len(ace) - 1] if name != ace else '@'
    if action == 'present':
        call('AddDomainRecord', DomainName=zone, RR=rr, Type='TXT', Value=value, TTL=TTL)
        return
    records = call('DescribeDomainRecords', DomainName=zone, RRKeyWord=rr, TypeKeyWord='TXT', PageSize=100)
    for rec in records['DomainRecords']['Record']:
        if rec['RR'] == rr and rec['Type'] == 'TXT' and rec['Value'] == value:
            call('DeleteDomainRecord', RecordId=rec['RecordId'])


main()
