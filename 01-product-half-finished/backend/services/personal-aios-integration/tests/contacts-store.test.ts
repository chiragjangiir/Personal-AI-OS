import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContactsStore,parseContactsBatch,type ContactRecord,type ContactsBatch} from '../src/contacts/store.ts';

const T0=1791504000000;
const card=(id:string,name='妈妈',relations:ContactRecord['relations']=[]):ContactRecord=>({id,name,
  phones:[{number:'+86 138 0000 0000',label:'手机'}],relations});
const batch=(control_id:string,contacts:ContactRecord[]=[],deleted:string[]=[]):ContactsBatch=>({control_id,contacts,deleted});
async function open(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'paios-contacts-')),directory=join(root,'contacts');let now=T0;
  const store=ContactsStore.open(directory,()=>now);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  return {store,directory,setTime:(v:number)=>{now=v;}};
}

test('durable atomic pages: canonical replay, changed replay refused, replay never restores deleted cards',async t=>{
  const {store,directory,setTime}=await open(t);
  const a=batch('packet:1',[card('contact/A:ABPerson')]);
  assert.deepEqual(store.ingest('owner','phone',a),{stored:1,deleted:0});
  setTime(T0+1000);
  const reordered={deleted:[],contacts:[{relations:[],phones:[{label:'手机',number:'+86 138 0000 0000'}],name:'妈妈',id:'contact/A:ABPerson'}],control_id:'packet:1'};
  assert.deepEqual(store.ingest('owner','phone',reordered),{stored:1,deleted:0});
  assert.equal(store.search('owner',{name:'妈妈'}).last_received_at_ms,T0);
  assert.throws(()=>store.ingest('owner','phone',batch('packet:1',[card('contact/A:ABPerson','改名')])),/CONTACTS_BATCH_CONFLICT/);
  assert.deepEqual(store.ingest('owner','phone',batch('packet:2',[],['contact/A:ABPerson','absent'])),{stored:0,deleted:1});
  assert.deepEqual(store.ingest('owner','phone',a),{stored:1,deleted:0});
  assert.equal(store.search('owner',{name:'妈妈'}).contacts.length,0);
  assert.deepEqual(store.ingest('owner','phone',batch('packet:2',[],['contact/A:ABPerson','absent'])),{stored:0,deleted:1});
  // A new acknowledged snapshot may re-add the same stable CNContact ID. Old delete replay must not delete it again.
  assert.deepEqual(store.ingest('owner','phone',batch('packet:3',[card('contact/A:ABPerson')])),{stored:1,deleted:0});
  store.ingest('owner','phone',batch('packet:2',[],['contact/A:ABPerson','absent']));
  assert.equal(store.search('owner',{name:'妈妈'}).contacts.length,1);
  assert.equal((await stat(directory)).mode&0o777,0o700);
  assert.equal((await stat(join(directory,'contacts.sqlite'))).mode&0o777,0o600);
  store.close();const reopened=ContactsStore.open(directory);t.after(()=>reopened.close());
  assert.equal(reopened.search('owner',{name:'妈妈'}).contacts.length,1);
  assert.deepEqual(reopened.ingest('owner','phone',a),{stored:1,deleted:0});
});

test('device-local IDs stay isolated; queries use only the latest committed device snapshot',async t=>{
  const {store}=await open(t);
  store.ingest('owner','phone',batch('same',[card('same','Phone Card')]));
  store.ingest('owner','phone2',batch('same',[card('same','Second Card')]));
  store.ingest('stranger','phone',batch('same',[card('same','Private Card')]));
  assert.deepEqual(store.search('owner',{name:'Card'}).contacts.map(c=>c.name),['Second Card']);
  assert.deepEqual(store.named('owner','Phone Card'),[]);
  store.ingest('owner','phone',batch('same',[card('same','Phone Card')]));
  assert.deepEqual(store.search('owner',{name:'Card'}).contacts.map(c=>c.name),['Second Card'],'old ACK replay cannot select the old device');
  assert.deepEqual(store.ingest('owner','phone2',batch('delete',[],['same'])),{stored:0,deleted:1});
  assert.deepEqual(store.search('owner',{name:'Card'}).contacts,[]);
  assert.deepEqual(store.search('stranger',{name:'Card'}).contacts.map(c=>c.name),['Private Card']);
  assert.equal(store.search('nobody',{name:'Card'}).last_received_at_ms,null);
  assert.equal(store.search('nobody',{name:'Card'}).age_ms,null);
});

test('snapshot choice survives restart and clock rollback; true homonyms and an empty replacement remain explicit',async t=>{
  const {store,directory,setTime}=await open(t);
  store.ingest('owner','old-phone',batch('old',[card('old'),card('retired','旧联系人')]));
  setTime(T0-1000);
  const current=card('new');current.phones[0]!.number='13900000001';
  store.ingest('owner','new-phone',batch('new',[current]));
  store.close();const reopened=ContactsStore.open(directory,()=>T0);t.after(()=>reopened.close());
  assert.deepEqual(reopened.named('owner','紧急联系人：妈妈'),[{name:current.name,phones:current.phones}]);
  assert.deepEqual(reopened.search('owner',{name:'旧联系人'}).contacts,[]);
  assert.equal(reopened.search('owner',{name:'妈妈'}).last_received_at_ms,T0-1000);
  reopened.ingest('owner','new-phone',batch('homonym',[card('other')]));
  assert.equal(reopened.named('owner','妈妈').length,2);
  assert.equal(reopened.search('owner',{name:'妈妈'}).contacts.length,2);
  reopened.ingest('owner','empty-phone',batch('empty'));
  assert.deepEqual(reopened.named('owner','妈妈'),[]);
  assert.deepEqual(reopened.search('owner',{name:'妈妈'}).contacts,[]);
});

test('interrupted replacement pages expose unknown sync completeness independently of query truncation and freshness',async t=>{
  const {store,directory,setTime}=await open(t);
  const old=batch('old',[card('old','Target')]);
  store.ingest('owner','old-phone',old);
  const cards=Array.from({length:48},(_,n)=>card(String(n),n===47?'Target':`Card ${n}`));
  setTime(T0+1000);
  store.ingest('owner','new-phone',batch('page-1',cards.slice(0,16)));
  store.close();const reopened=ContactsStore.open(directory,()=>T0+1100);t.after(()=>reopened.close());
  const missing=reopened.search('owner',{name:'Target'});
  assert.deepEqual(missing.contacts,[]);
  assert.equal(missing.truncated,false);
  assert.equal(missing.age_ms,100);
  assert.equal(missing.sync_completeness,'unknown');
  assert.equal(reopened.search('owner',{name:'Card',limit:2}).truncated,true);
  assert.equal(reopened.search('owner',{name:'Card',limit:2}).sync_completeness,'unknown');
  reopened.ingest('owner','old-phone',old);
  assert.deepEqual(reopened.search('owner',{name:'Target'}).contacts,[],'old ACK replay cannot restore the old device');
  reopened.ingest('owner','new-phone',batch('page-2',cards.slice(16,32)));
  reopened.ingest('owner','new-phone',batch('page-3',cards.slice(32)));
  assert.equal(reopened.search('owner',{name:'Target'}).contacts.length,1);
  assert.equal(reopened.search('owner',{name:'Target'}).sync_completeness,'unknown','legacy pages cannot attest a completed snapshot');
  assert.equal(reopened.search('nobody',{name:'Target'}).sync_completeness,'unknown');
});

test('name/relation filters preserve directed edges, do not infer relatives or medical emergency contacts',async t=>{
  const {store,setTime}=await open(t);
  const own=card('own','主人',[{label:'母亲',name:'李女士'}]);
  const labelled=card('labelled','陈女士');labelled.phones[0]!.label='母亲';
  store.ingest('owner','phone',batch('1',[own,card('mom','母亲'),labelled,card('other','李女士')]));
  const result=store.search('owner',{relation:'母亲'});
  assert.deepEqual(result.contacts.map(c=>c.name),['主人','母亲','陈女士']);
  assert.equal(result.relation_direction,'from_contact_to_named_person');
  assert.deepEqual(result.contacts[0]!.relations,[{label:'母亲',name:'李女士'}]);
  assert.deepEqual(result.contacts[1]!.relations,[]);
  assert.deepEqual(store.search('owner',{name:'李女士'}).contacts.map(c=>c.name),['李女士']);
  assert.deepEqual(store.search('owner',{name:'主人',relation:'母亲'}).contacts.map(c=>c.name),['主人']);
  assert.equal(store.search('owner',{name:'李女士',relation:'母亲'}).contacts.length,0);
  assert.equal('emergency_contact' in result,false);
  setTime(T0+100);assert.equal(store.search('owner',{relation:'母亲'}).age_ms,100);
  const limited=store.search('owner',{relation:'母亲',limit:2});assert.equal(limited.truncated,true);assert.equal(limited.contacts.length,2);
});

test('literal SQL LIKE metacharacters and quote injection do not widen queries',async t=>{
  const {store}=await open(t);
  const literal=card('literal',"Name%_\\' OR 1=1 --");literal.phones[0]!.label='%_\\';
  store.ingest('owner','phone',batch('1',[literal,card('ordinary','Name ordinary')]));
  for(const name of ['%','_','\\',"' OR 1=1 --"]){assert.deepEqual(store.search('owner',{name}).contacts.map(c=>c.name),[literal.name]);}
  assert.deepEqual(store.search('owner',{relation:'%_\\'}).contacts.map(c=>c.name),[literal.name]);
  assert.equal(store.search('owner',{name:'no match'}).truncated,false);
});

test('malformed, duplicate, contradictory and field/count violations fail before any row or ledger change',async t=>{
  const {store}=await open(t);
  const good=batch('ok',[card('id')]);
  const invalid:unknown[]=[null,[],{}, {...good,extra:1}, {...good,control_id:'bad id'}, {...good,deleted:'id'},
    {...good,deleted:['id','id']}, {...good,deleted:['id']}, {...good,contacts:[card('id'),card('id')]},
    {...good,contacts:[{...card('id'),extra:1}]}, {...good,contacts:[{...card('id'),id:''}]},
    {...good,contacts:[{...card('id'),id:'x'.repeat(257)}]}, {...good,contacts:[{...card('id'),name:'x'.repeat(161)}]},
    {...good,contacts:[{...card('id'),phones:[{number:'',label:'手机'}]}]},
    {...good,contacts:[{...card('id'),phones:[{number:'123',label:'\0'}]}]},
    {...good,contacts:[{...card('id'),relations:[{label:'母亲',name:''}]}]},
    {...good,contacts:Array.from({length:17},(_,n)=>card(String(n)))}, {...good,deleted:Array.from({length:129},(_,n)=>String(n))},
    {...good,contacts:[{...card('id'),phones:Array.from({length:17},()=>({number:'1',label:'手机'}))}]},
    {...good,contacts:[{...card('id'),relations:Array.from({length:17},()=>({label:'母亲',name:'李女士'}))}]}];
  for(const value of invalid)assert.throws(()=>store.ingest('owner','phone',value as ContactsBatch),/CONTACTS_(BATCH|RECORD)/);
  assert.deepEqual(store.ingest('owner','phone',good),{stored:1,deleted:0});
  for(const args of [{},{name:''},{name:' '},{relation:'x'.repeat(161)},{name:'妈妈',limit:0},{name:'妈妈',limit:21},
    {name:'妈妈',limit:1.5},{name:'妈妈',extra:1},null])assert.throws(()=>store.search('owner',args as never),/CONTACTS_QUERY_INVALID/);
  assert.throws(()=>store.ingest('bad principal','phone',good),/CONTACTS_BATCH_INVALID/);
  assert.throws(()=>store.search('bad principal',{name:'妈妈'}),/CONTACTS_QUERY_INVALID/);
  assert.equal(parseContactsBatch(good),good);
  // No UUID requirement or forced name: a phone-only card with an opaque ID remains usable by its phone label.
  store.ingest('owner','phone',batch('unnamed',[card('CNContact/opaque:ABC','')]));
  assert.equal(store.search('owner',{relation:'手机'}).contacts.length,2);
  // JSON Schema and the phone count Unicode scalars, not UTF-16 code units.
  const name='😀'.repeat(160);
  store.ingest('owner','phone',batch('unicode',[card('emoji',name)]));
  assert.equal(store.search('owner',{name}).contacts[0]!.name,name);
});
