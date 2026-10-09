import {checkRateLimit} from '../auth';
describe('credential strings cannot bypass limits',()=>{
  test('arbitrary key receives free tier accounting',()=>{
    expect(checkRateLimit('attacker-controlled','auth-fake-key')).toEqual({allowed:true,remaining:99,tier:'free'});
  });
  test('rotating fake keys shares the IP daily bucket',()=>{
    for(let i=0;i<100;i++) expect(checkRateLimit(`fake-${i}`,'auth-rotating').allowed).toBe(true);
    expect(checkRateLimit('another-key','auth-rotating').allowed).toBe(false);
  });
  test('fake key cannot bypass minute counter',()=>{
    let last;
    for(let i=0;i<121;i++) last=checkRateLimit('fixture-registered','auth-burst',{plan:'pro'});
    expect(last!.allowed).toBe(false);
  });
});
