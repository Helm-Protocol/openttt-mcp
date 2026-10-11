//! Preserve and reject duplicate keys before conversion into serde_json::Value.
use serde::{de::{self, MapAccess, SeqAccess, Visitor}, Deserialize, Deserializer};
use serde_json::{Map, Number, Value};
use std::fmt;
struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self,D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Strict;
            fn expecting(&self,f:&mut fmt::Formatter) -> fmt::Result { f.write_str("JSON without duplicate keys") }
            fn visit_bool<E:de::Error>(self,v:bool)->Result<Strict,E>{Ok(Strict(Value::Bool(v)))}
            fn visit_i64<E:de::Error>(self,v:i64)->Result<Strict,E>{Ok(Strict(Value::Number(v.into())))}
            fn visit_u64<E:de::Error>(self,v:u64)->Result<Strict,E>{Ok(Strict(Value::Number(v.into())))}
            fn visit_f64<E:de::Error>(self,v:f64)->Result<Strict,E>{Number::from_f64(v).map(|n|Strict(Value::Number(n))).ok_or_else(||E::custom("invalid number"))}
            fn visit_str<E:de::Error>(self,v:&str)->Result<Strict,E>{Ok(Strict(Value::String(v.into())))}
            fn visit_string<E:de::Error>(self,v:String)->Result<Strict,E>{Ok(Strict(Value::String(v)))}
            fn visit_unit<E:de::Error>(self)->Result<Strict,E>{Ok(Strict(Value::Null))}
            fn visit_seq<A:SeqAccess<'de>>(self,mut a:A)->Result<Strict,A::Error>{
                let mut values=Vec::new(); while let Some(Strict(v))=a.next_element()?{values.push(v);} Ok(Strict(Value::Array(values)))
            }
            fn visit_map<A:MapAccess<'de>>(self,mut a:A)->Result<Strict,A::Error>{
                let mut values=Map::new();
                while let Some(k)=a.next_key::<String>()?{
                    if values.contains_key(&k){return Err(de::Error::custom("DUPLICATE_JSON_KEY"));}
                    let Strict(v)=a.next_value()?; values.insert(k,v);
                }
                Ok(Strict(Value::Object(values)))
            }
        }
        d.deserialize_any(V)
    }
}
pub fn from_slice<T:de::DeserializeOwned>(bytes:&[u8])->Result<T,serde_json::Error>{
    let Strict(value)=serde_json::from_slice(bytes)?;
    serde_json::from_value(value)
}
