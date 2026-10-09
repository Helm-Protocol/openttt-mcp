import {createHash} from 'crypto';
import {computeDraft13ExporterContext, computeDraft13BindingInput, verifyDraft13BindingProof, draft13Freshness, verifyPotRecordV2} from '../pot_record_v2';
const vectors = require('./draft13-vectors.json');
const exporter = Buffer.from(Array.from({length:32},(_,i)=>i+32));
const issuer = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a','hex');
for(const type of ['ed25519','psk']) {
  const v=vectors[type], record=Buffer.from(v.record,'hex'), proof=Buffer.from(v.holder_proof,'hex');
  const secret=type==='psk'?Buffer.from(Array.from({length:32},(_,i)=>i)):undefined;
  test(`${type}: official draft13 Appendix B bytes and proofs`,()=>{
    expect(createHash('sha256').update(record).digest('hex')).toBe(v.record_hash);
    expect(verifyPotRecordV2(record,issuer).verdict).toBe('intact');
    expect(computeDraft13ExporterContext(record).toString('hex')).toBe(v.exporter_context_hash);
    expect(computeDraft13BindingInput(record,exporter).toString('hex')).toBe(v.binding_input);
    expect(verifyDraft13BindingProof(record,proof,exporter,0,secret).verdict).toBe('intact');
  });
  test(`${type}: direction/session/whole-record substitution fails`,()=>{
    expect(verifyDraft13BindingProof(record,proof,exporter,1,secret).verdict).toBe('rejected');
    expect(verifyDraft13BindingProof(record,proof,Buffer.alloc(32),0,secret).verdict).toBe('rejected');
    const changed=Buffer.from(record);changed[179]^=1;
    expect(verifyDraft13BindingProof(changed,proof,exporter,0,secret).verdict).toBe('rejected');
    expect(()=>computeDraft13ExporterContext(Buffer.concat([record,Buffer.alloc(1)]))).toThrow();
    expect(()=>computeDraft13ExporterContext(record,2 as 0)).toThrow();
  });
}
test('asymmetric future limit ignores dispersion, equality and uint64 overflow',()=>{
  expect(draft13Freshness(1500n,1000n,999999n,1000n,500n)).toBe(true);
  expect(draft13Freshness(1501n,1000n,999999n,1000n,500n)).toBe(false);
  expect(draft13Freshness(1000n,2100n,100n,1000n,500n)).toBe(true);
  expect(draft13Freshness(1000n,2101n,100n,1000n,500n)).toBe(false);
  expect(draft13Freshness(1000n,1001n,1n,(1n<<64n)-1n,500n)).toBe(false);
  expect(draft13Freshness(-1n,0n,0n,1n,1n)).toBe(false);
});
