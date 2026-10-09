// Reproduce published, explicitly public test keys. Never use a live TLS exporter here.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const V2=require('../dist/pot_record_v2.js');
const fixtures=require('../__tests__/draft13-vectors.json');
const key=seed=>crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(seed,'hex')]),format:'der',type:'pkcs8'});
const issuer=key('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const holder=key('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb');
const psk=Buffer.from(Array.from({length:32},(_,i)=>i));
const exporter=Buffer.from(Array.from({length:32},(_,i)=>i+32));
const text=fs.readFileSync(new URL('../docs/draft13/published-draft13.txt',import.meta.url),'utf8');
const appendix=text.slice(text.lastIndexOf('Appendix B.  Fixed Cryptographic and Binding Vectors'),text.lastIndexOf('Appendix C.'));
const out={source:'https://www.ietf.org/archive/id/draft-helmprotocol-tttps-13.txt',exporter_kind:'public deterministic fixture; not real TLS key derivation',exporter_fixture:exporter.toString('hex'),vectors:{}};
for(const type of ['ed25519','psk']){
 const data=type==='ed25519'?crypto.createPublicKey(holder).export({type:'spki',format:'der'}).subarray(-32):crypto.createHash('sha256').update(psk).digest();
 const record=V2.encodePotRecordV2({holderAuthType:type==='ed25519'?1:2,algId:1,tsTaiUs:2100000000000000n,dispersionUs:100,
   ctxId:Buffer.from('00112233445566778899aabbccddeeff','hex'),nonce:Buffer.from('ffeeddccbbaa99887766554433221100','hex'),holderAuthData:data,issuerKeyId:1001},issuer);
 const binding=V2.computeDraft13BindingInput(record,exporter,0);
 const proof=type==='ed25519'?crypto.sign(null,binding,holder):crypto.createHmac('sha256',psk).update(binding).digest();
 const values={record:record.toString('hex'),record_hash:crypto.createHash('sha256').update(record).digest('hex'),
   exporter_context_hash:V2.computeDraft13ExporterContext(record,0).toString('hex'),binding_input:binding.toString('hex'),holder_proof:proof.toString('hex'),presentation:Buffer.concat([record,proof]).toString('hex'),
   integrity_tag:record.subarray(80,112).toString('hex'),issuer_signed_bytes:record.subarray(0,116).toString('hex'),issuer_signature:record.subarray(116).toString('hex')};
 const section=type==='ed25519'?appendix.split('B.2.')[1].split('B.3.')[0]:appendix.split('B.3.')[1];
 for(const [field,hex] of Object.entries(values)){
   const lines=section.split(/\r?\n/);
   const start=lines.findIndex(line=>line.trim()===field+':');
   const chunks=[];
   for(let i=start+1; start>=0 && i<lines.length && /^[ \t]*[0-9a-f]+[ \t]*$/.test(lines[i]);i++)chunks.push(lines[i].trim());
   if(start<0 || chunks.join('')!==hex)throw new Error(`Published Appendix B mismatch: ${type}.${field}`);
   if(field in fixtures[type] && fixtures[type][field]!==hex)throw new Error(`Harness fixture mismatch: ${type}.${field}`);
 }
 if(record.length!==180 || binding.length!==90)throw new Error('Invalid layout');
 out.vectors[type]={...values,direction:0,server_direction_context:V2.computeDraft13ExporterContext(record,1).toString('hex'),server_direction_binding_input:V2.computeDraft13BindingInput(record,exporter,1).toString('hex')};
}
process.stdout.write(JSON.stringify(out,null,2)+'\n');
