import {constants,promises as fs} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOwnerOverrideSecret} from '../src/owner-override.ts';

async function provision(){
  if(process.argv.length!==2||process.stdin.isTTY||!process.env.PAIOS_SECRET_ROOT)throw new Error('INVALID_INPUT');
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of process.stdin){
    const value=Buffer.from(chunk);bytes+=value.length;if(bytes>4098)throw new Error('INVALID_INPUT');chunks.push(value);
  }
  const passphrase=Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/,'');
  if(/[\r\n]/.test(passphrase))throw new Error('INVALID_INPUT');
  const secret=await createOwnerOverrideSecret(passphrase),root=process.env.PAIOS_SECRET_ROOT;
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const temporary=join(root,`.owner-override-${randomUUID()}`);
  const file=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{
    try{await file.chmod(0o600);await file.writeFile(JSON.stringify(secret));await file.sync();}finally{await file.close();}
    await fs.rename(temporary,join(root,'owner-override.json'));
    const directory=await fs.open(root,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}
  }finally{await fs.unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
}
provision().catch(()=>{process.stderr.write('OWNER_OVERRIDE_PROVISION_FAILED\n');process.exitCode=1;});
