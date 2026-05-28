import { useState, useEffect, useRef } from "react";

// ── CHANGE THIS to your deployed pipeline URL after deploying ──────────────
const PIPELINE_URL = "https://adishila-pipeline.onrender.com/webhook/sample";
const WEBHOOK_SECRET = "d5edb1a3647a8fb3c0077c43b5f7c569"; // must match server .env
// ──────────────────────────────────────────────────────────────────────────

const PRODUCTS = {
  "1": { name: "Kavach Shield OM",         sku: "ADI-01", ws: 800,  mrp: 1499, moq: 25, icon: "🛡️" },
  "2": { name: "Vastu Dosh Pyramid",        sku: "ADI-02", ws: 1100, mrp: 2199, moq: 25, icon: "🔺" },
  "3": { name: "Rudra-Shila Raksha Mala",  sku: "ADI-03", ws: 900,  mrp: 1499, moq: 25, icon: "📿" },
  "4": { name: "Amrit Jal Shuddhi Set",    sku: "ADI-04", ws: 950,  mrp: 1999, moq: 25, icon: "💧" },
  "5": { name: "Shila Raksha Pendant OM",  sku: "ADI-05", ws: 700,  mrp: 1299, moq: 25, icon: "🪬" },
};
const REQUEST_TYPES  = { "1": "Sample Request", "2": "Bulk Quote", "3": "Reorder" };
const BUSINESS_TYPES = { "1": "Retailer", "2": "Distributor", "3": "Individual / Gift Buyer" };

// ── Simple HMAC-SHA256 using SubtleCrypto (browser native) ────────────────
async function signPayload(payload) {
  const body = JSON.stringify(
    Object.keys(payload).sort().reduce((acc, k) => { acc[k] = payload[k]; return acc; }, {})
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,"0")).join("");
}

async function fireWebhook(data) {
  const payload = { ...data };
  payload.signature = await signPayload({ ...payload });
  const res = await fetch(PIPELINE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Pipeline responded ${res.status}`);
  return res.json();
}

function genTicket() {
  const h = Math.random().toString(36).toUpperCase().slice(2, 11);
  return `SMP-${h.slice(0,5)}-${h.slice(5)}`;
}

function parseProducts(raw) {
  return raw.replace(/\s/g,"").split(",")
    .filter(k => PRODUCTS[k])
    .map(k => ({ key: k, ...PRODUCTS[k], qty: 2 }));
}

const INIT_STATE = () => ({
  state: "ASK_REQUEST_TYPE",
  data: {
    request_type: null, name: null, business_name: null,
    business_type: null, products: [],
    phone: null, email: null, gst_number: null,
    notes: null, prior_ticket: null,
  }
});

function botReply(session, txt) {
  const { state, data } = session;
  let next = { ...session, data: { ...data } };
  const d = next.data;
  const t = txt.trim();

  if (["cancel","exit","quit","menu"].includes(t.toLowerCase()))
    return { reset: true };

  if (state === "ASK_REQUEST_TYPE") {
    if (!REQUEST_TYPES[t]) return { session, reply: "Please choose 1, 2, or 3." };
    d.request_type = REQUEST_TYPES[t];
    next.state = "ASK_NAME";
    return { session: next, reply: "What is your full name?" };
  }
  if (state === "ASK_NAME") {
    if (t.length < 2) return { session, reply: "Please enter a valid name." };
    d.name = t.split(" ").map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(" ");
    next.state = "ASK_BUSINESS_NAME";
    return { session: next, reply: `Namaste, ${d.name}! Your business or store name? (type "individual" if personal)` };
  }
  if (state === "ASK_BUSINESS_NAME") {
    d.business_name = t;
    next.state = "ASK_BUSINESS_TYPE";
    return { session: next, reply: "BTYPE" };
  }
  if (state === "ASK_BUSINESS_TYPE") {
    if (!BUSINESS_TYPES[t]) return { session, reply: "Please choose 1, 2, or 3." };
    d.business_type = BUSINESS_TYPES[t];
    if (d.request_type === "Reorder") {
      next.state = "ASK_REORDER_TICKET";
      return { session: next, reply: 'Share your previous Ticket ID (e.g. SMP-XXXXX-XXXX) or type "skip".' };
    }
    next.state = "ASK_PRODUCTS";
    return { session: next, reply: "PRODUCTS" };
  }
  if (state === "ASK_REORDER_TICKET") {
    d.prior_ticket = t.toLowerCase() === "skip" ? null : t.toUpperCase();
    next.state = "ASK_PRODUCTS";
    return { session: next, reply: "PRODUCTS" };
  }
  if (state === "ASK_PRODUCTS") {
    const chosen = parseProducts(t);
    if (!chosen.length) return { session, reply: 'Enter product numbers separated by commas, e.g. "1, 3, 5"' };
    d.products = chosen;
    if (d.request_type === "Sample Request") {
      next.state = "ASK_SAMPLE_CONFIRM";
      return { session: next, reply: `Selected: ${chosen.map(p=>p.name).join(", ")}\n\nSamples are 2 pcs per product. Type "yes" to confirm or "change" to reselect.` };
    }
    next.state = "ASK_BULK_QTY";
    return { session: next, reply: `Products: ${chosen.map(p=>p.name).join(", ")}\n\nHow many pieces per product? (MOQ: ${d.request_type === "Reorder" ? "10" : "25"} pcs)` };
  }
  if (state === "ASK_SAMPLE_CONFIRM") {
    if (t.toLowerCase() === "change") { next.state = "ASK_PRODUCTS"; return { session: next, reply: "PRODUCTS" }; }
    if (t.toLowerCase() !== "yes") return { session, reply: 'Type "yes" to confirm or "change" to reselect.' };
    d.products.forEach(p => p.qty = 2);
    next.state = "ASK_PHONE";
    return { session: next, reply: "Your phone number?" };
  }
  if (state === "ASK_BULK_QTY") {
    if (!/^\d+$/.test(t) || +t < 1) return { session, reply: "Please enter a valid number." };
    const qty = +t, minMoq = d.request_type === "Reorder" ? 10 : 25;
    if (qty < minMoq) return { session, reply: `Minimum is ${minMoq} pcs for ${d.request_type.toLowerCase()}s. Please try again.` };
    d.products.forEach(p => p.qty = qty);
    next.state = "ASK_PHONE";
    return { session: next, reply: "Your phone number?" };
  }
  if (state === "ASK_PHONE") {
    const digits = t.replace(/\D/g,"");
    if (digits.length < 10) return { session, reply: "Please enter a valid 10-digit number." };
    d.phone = digits.slice(-10);
    next.state = "ASK_EMAIL";
    return { session: next, reply: 'Your email address? (or type "skip")' };
  }
  if (state === "ASK_EMAIL") {
    if (t.toLowerCase() === "skip") { d.email = null; }
    else if (!t.includes("@") || !t.includes(".")) return { session, reply: 'Doesn\'t look valid — try again or type "skip".' };
    else d.email = t.toLowerCase();
    next.state = "ASK_GST";
    return { session: next, reply: 'GST number? (or type "skip")' };
  }
  if (state === "ASK_GST") {
    d.gst_number = t.toLowerCase() === "skip" ? null : t.toUpperCase();
    next.state = "ASK_NOTES";
    return { session: next, reply: 'Any special notes — delivery preferences, requirements, etc.? (or type "skip")' };
  }
  if (state === "ASK_NOTES") {
    d.notes = t.toLowerCase() === "skip" ? null : t;
    next.state = "CONFIRM";
    return { session: next, reply: "SUMMARY" };
  }
  if (state === "CONFIRM") {
    if (t.toLowerCase() === "edit") return { reset: true, keepGreet: true };
    if (t.toLowerCase() !== "confirm") return { session, reply: 'Type "confirm" to submit or "edit" to restart.' };
    next.state = "SUBMITTING";
    return { session: next, reply: "SUBMITTING" };
  }
  return { session, reply: "Type anything to continue." };
}

// ── React component ───────────────────────────────────────────────────────
export default function VyaparBot() {
  const [msgs, setMsgs]         = useState([]);
  const [session, setSession]   = useState(INIT_STATE());
  const [input, setInput]       = useState("");
  const [typing, setTyping]     = useState(false);
  const [started, setStarted]   = useState(false);
  const [selectedProds, setSP]  = useState([]);
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, typing]);

  const addMsg = (role, content) =>
    setMsgs(m => [...m, { role, content, id: Date.now()+Math.random() }]);

  const greetWidget = () => ({
    type: "choices",
    text: "What would you like to do today?",
    choices: [
      { label: "Request Product Samples", value: "1", icon: "📦" },
      { label: "Get a Bulk Quote",         value: "2", icon: "📊" },
      { label: "Place a Reorder",          value: "3", icon: "🔁" },
    ]
  });

  const botDelay = (fn) => { setTyping(true); setTimeout(() => { setTyping(false); fn(); }, 700+Math.random()*300); };

  const dispatchReply = (nextSess, reply) => {
    botDelay(() => {
      if (!reply || reply === "GREET_CHOICES") { addMsg("bot", greetWidget()); return; }
      if (reply === "PRODUCTS")   { addMsg("bot", { type: "product_menu" }); return; }
      if (reply === "BTYPE")      { addMsg("bot", { type: "choices", text: "What best describes you?", choices: [
        { label: "Retailer (shop / boutique)", value: "1", icon: "🏪" },
        { label: "Distributor (bulk reseller)", value: "2", icon: "🏭" },
        { label: "Individual / Gift Buyer",    value: "3", icon: "🎁" },
      ]}); return; }
      if (reply === "SUMMARY")    { addMsg("bot", { type: "summary", data: nextSess.data }); return; }
      if (reply === "SUBMITTING") { handleSubmit(nextSess.data); return; }
      addMsg("bot", { type: "text", text: reply });
    });
  };

  const handleSubmit = async (data) => {
    setTyping(true);
    const ticket = genTicket();
    const payload = {
      ticket_id: ticket,
      event: (data.request_type||"").toLowerCase().replace(/ /g,"_"),
      name: data.name,
      business_name: data.business_name,
      business_type: data.business_type,
      phone: data.phone,
      email: data.email,
      gst_number: data.gst_number,
      products: data.products,
      notes: data.notes,
      prior_ticket: data.prior_ticket,
      timestamp: new Date().toISOString(),
    };
    try {
      await fireWebhook(payload);
      setTyping(false);
      addMsg("bot", { type: "done", ticketId: ticket });
    } catch (err) {
      setTyping(false);
      addMsg("bot", { type: "error", ticketId: ticket, err: err.message });
    }
  };

  const processInput = (val) => {
    const result = botReply(session, val);
    if (result.reset) {
      const fresh = INIT_STATE();
      setSession(fresh);
      setSP([]);
      dispatchReply(fresh, "GREET_CHOICES");
      return;
    }
    setSession(result.session);
    dispatchReply(result.session, result.reply);
  };

  const handleSend = (override) => {
    const val = (override !== undefined ? String(override) : input).trim();
    if (!val) return;
    setInput("");
    addMsg("user", { type: "text", text: val });
    processInput(val);
  };

  const handleChoiceRaw = (displayText, sendValue) => {
    addMsg("user", { type: "text", text: displayText });
    processInput(sendValue);
  };

  const sendProducts = () => {
    if (!selectedProds.length) return;
    const val = selectedProds.join(",");
    const labels = selectedProds.map(k => PRODUCTS[k].name).join(", ");
    addMsg("user", { type: "text", text: labels });
    setSP([]);
    processInput(val);
  };

  const startChat = () => {
    setStarted(true);
    const fresh = INIT_STATE();
    setSession(fresh);
    botDelay(() => {
      addMsg("bot", { type: "welcome" });
      setTimeout(() => addMsg("bot", greetWidget()), 700);
    });
  };

  // ── Render a single message ─────────────────────────────────────────────
  const renderMsg = ({ role, content }) => {
    const isBot = role === "bot";

    const Bubble = ({ children, style = {} }) => (
      <div style={{ display:"flex", justifyContent: isBot?"flex-start":"flex-end", marginBottom:10, alignItems:"flex-end", gap:8 }}>
        {isBot && (
          <div style={{ width:32,height:32,borderRadius:"50%",background:"linear-gradient(135deg,#c8a96e,#8b6914)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0,marginBottom:2 }}>🪨</div>
        )}
        <div style={{
          maxWidth:"78%",
          background: isBot ? "rgba(255,255,255,0.055)" : "linear-gradient(135deg,#c8a96e,#a07820)",
          borderRadius: isBot ? "4px 16px 16px 16px" : "16px 4px 16px 16px",
          padding:"11px 15px",
          color: isBot ? "#e8dcc8" : "#1a1206",
          fontSize:14, lineHeight:1.6,
          border: isBot ? "1px solid rgba(200,169,110,0.13)" : "none",
          boxShadow: isBot ? "none" : "0 2px 12px rgba(200,169,110,0.22)",
          ...style,
        }}>{children}</div>
      </div>
    );

    if (content.type === "text")
      return <Bubble><span style={{ whiteSpace:"pre-wrap" }}>{content.text}</span></Bubble>;

    if (content.type === "welcome") return (
      <div style={{ textAlign:"center", margin:"8px 0 20px" }}>
        <div style={{ fontSize:44, marginBottom:8 }}>🪨</div>
        <p style={{ color:"#c8a96e", fontWeight:700, fontSize:17, margin:"0 0 4px", letterSpacing:1 }}>VyaparBot</p>
        <p style={{ color:"#5c5040", fontSize:12, letterSpacing:2, textTransform:"uppercase", margin:0 }}>AdiShila Wholesale Assistant</p>
      </div>
    );

    if (content.type === "choices") return (
      <div style={{ marginBottom:10 }}>
        <Bubble><span style={{ color:"#d4bc8a" }}>{content.text}</span></Bubble>
        <div style={{ display:"flex", flexDirection:"column", gap:7, paddingLeft:40 }}>
          {content.choices.map(c => (
            <button key={c.value} onClick={() => handleChoiceRaw(c.label, c.value)} style={{
              background:"rgba(200,169,110,0.07)", border:"1px solid rgba(200,169,110,0.28)",
              borderRadius:12, padding:"10px 15px", color:"#e8dcc8", fontSize:14,
              cursor:"pointer", textAlign:"left", display:"flex", alignItems:"center", gap:10,
              transition:"background 0.18s",
            }}
            onMouseEnter={e=>e.currentTarget.style.background="rgba(200,169,110,0.17)"}
            onMouseLeave={e=>e.currentTarget.style.background="rgba(200,169,110,0.07)"}
            >
              <span style={{ fontSize:18 }}>{c.icon}</span>{c.label}
            </button>
          ))}
        </div>
      </div>
    );

    if (content.type === "product_menu") return (
      <div style={{ marginBottom:10 }}>
        <Bubble><span style={{ color:"#d4bc8a" }}>Select the products you want (tap to toggle):</span></Bubble>
        <div style={{ display:"flex", flexDirection:"column", gap:6, paddingLeft:40 }}>
          {Object.entries(PRODUCTS).map(([k, p]) => {
            const sel = selectedProds.includes(k);
            return (
              <button key={k} onClick={() => setSP(prev => prev.includes(k) ? prev.filter(x=>x!==k) : [...prev,k])} style={{
                background: sel ? "rgba(200,169,110,0.2)" : "rgba(255,255,255,0.04)",
                border: sel ? "1px solid rgba(200,169,110,0.65)" : "1px solid rgba(200,169,110,0.18)",
                borderRadius:10, padding:"9px 13px", color:"#e8dcc8", fontSize:13,
                cursor:"pointer", textAlign:"left", display:"flex", alignItems:"center",
                justifyContent:"space-between", transition:"all 0.18s",
              }}>
                <span style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span>{p.icon}</span><span>{p.name}</span>
                </span>
                <span style={{ color:"#c8a96e", fontSize:12 }}>
                  ₹{p.ws} WS{sel && <span style={{ marginLeft:8, color:"#6fcf97" }}>✓</span>}
                </span>
              </button>
            );
          })}
          {selectedProds.length > 0 && (
            <button onClick={sendProducts} style={{
              marginTop:3, background:"linear-gradient(135deg,#c8a96e,#a07820)",
              border:"none", borderRadius:10, padding:"11px", color:"#1a1206",
              fontWeight:700, fontSize:14, cursor:"pointer",
            }}>
              Confirm {selectedProds.length} product{selectedProds.length>1?"s":""} →
            </button>
          )}
        </div>
      </div>
    );

    if (content.type === "summary") {
      const d = content.data;
      return (
        <div style={{ marginBottom:10, paddingLeft:40 }}>
          <div style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(200,169,110,0.28)", borderRadius:14, padding:"16px 17px", color:"#e8dcc8", fontSize:13 }}>
            <p style={{ color:"#c8a96e", fontWeight:700, fontSize:11, letterSpacing:1.5, margin:"0 0 12px", textTransform:"uppercase" }}>📋 Request Summary</p>
            {[["Type",d.request_type],["Name",d.name],["Business",`${d.business_name} · ${d.business_type}`],["Phone",d.phone],["Email",d.email||"—"],["GST",d.gst_number||"—"],["Notes",d.notes||"—"]].map(([k,v])=>(
              <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"5px 0", borderBottom:"1px solid rgba(255,255,255,0.05)" }}>
                <span style={{ color:"#8a7a65" }}>{k}</span>
                <span style={{ maxWidth:"60%", textAlign:"right" }}>{v}</span>
              </div>
            ))}
            <p style={{ color:"#c8a96e", margin:"12px 0 6px", fontWeight:600, fontSize:11, textTransform:"uppercase", letterSpacing:1 }}>Products</p>
            {d.products.map(p=>(
              <div key={p.key} style={{ display:"flex", justifyContent:"space-between", padding:"4px 0" }}>
                <span>{p.icon} {p.name}</span>
                <span style={{ color:"#c8a96e" }}>× {p.qty} pcs</span>
              </div>
            ))}
            <div style={{ display:"flex", gap:9, marginTop:16 }}>
              <button onClick={()=>handleChoiceRaw("confirm","confirm")} style={{
                flex:1, background:"linear-gradient(135deg,#c8a96e,#a07820)",
                border:"none", borderRadius:10, padding:"11px",
                color:"#1a1206", fontWeight:700, fontSize:14, cursor:"pointer",
              }}>Submit & Save to Sheets ✓</button>
              <button onClick={()=>handleChoiceRaw("edit","edit")} style={{
                flex:1, background:"transparent",
                border:"1px solid rgba(200,169,110,0.32)", borderRadius:10, padding:"11px",
                color:"#c8a96e", fontSize:14, cursor:"pointer",
              }}>Edit ↩</button>
            </div>
          </div>
        </div>
      );
    }

    if (content.type === "done") return (
      <div style={{ paddingLeft:40, marginBottom:10 }}>
        <div style={{ background:"rgba(111,207,151,0.07)", border:"1px solid rgba(111,207,151,0.32)", borderRadius:14, padding:"20px 17px", textAlign:"center" }}>
          <div style={{ fontSize:32, marginBottom:8 }}>✅</div>
          <p style={{ color:"#6fcf97", fontWeight:700, fontSize:16, margin:"0 0 6px" }}>Saved to Google Sheets!</p>
          <p style={{ color:"#8a7a65", fontSize:12, margin:"0 0 14px" }}>All details have been recorded in the CRM</p>
          <div style={{ background:"rgba(200,169,110,0.1)", border:"1px solid rgba(200,169,110,0.28)", borderRadius:8, padding:"10px 14px", display:"inline-block" }}>
            <p style={{ color:"#8a7a65", fontSize:11, margin:"0 0 3px", letterSpacing:1 }}>TICKET ID</p>
            <p style={{ color:"#c8a96e", fontWeight:700, fontSize:17, margin:0, letterSpacing:2 }}>{content.ticketId}</p>
          </div>
          <p style={{ color:"#8a7a65", fontSize:13, marginTop:14 }}>Team will contact you within <strong style={{ color:"#e8dcc8" }}>48 hours</strong>.</p>
          <p style={{ color:"#5c4f3e", fontSize:12, marginTop:4 }}>Namaste 🙏 — AdiShila, The Primordial Stone</p>
        </div>
      </div>
    );

    if (content.type === "error") return (
      <div style={{ paddingLeft:40, marginBottom:10 }}>
        <div style={{ background:"rgba(226,75,74,0.08)", border:"1px solid rgba(226,75,74,0.3)", borderRadius:14, padding:"16px 17px" }}>
          <p style={{ color:"#e24b4a", fontWeight:700, margin:"0 0 6px" }}>⚠️ Pipeline not reachable</p>
          <p style={{ color:"#8a7a65", fontSize:13, margin:"0 0 10px" }}>Your request was collected but couldn't reach the server. Please check PIPELINE_URL in the code.</p>
          <p style={{ color:"#8a7a65", fontSize:12, margin:0 }}>Ticket ref: <span style={{ color:"#c8a96e" }}>{content.ticketId}</span></p>
        </div>
      </div>
    );

    return null;
  };

  const isDone = session.state === "DONE" || session.state === "SUBMITTING";

  return (
    <div style={{ minHeight:"100vh", background:"#0d0b08", display:"flex", flexDirection:"column", fontFamily:"Georgia,'Times New Roman',serif" }}>

      {/* ── Header ─── */}
      <div style={{ background:"rgba(13,11,8,0.96)", borderBottom:"1px solid rgba(200,169,110,0.18)", padding:"13px 18px", display:"flex", alignItems:"center", gap:12, position:"sticky", top:0, zIndex:10 }}>
        <div style={{ width:38,height:38,borderRadius:"50%",background:"linear-gradient(135deg,#c8a96e,#5c3d0a)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18 }}>🪨</div>
        <div>
          <p style={{ color:"#c8a96e", fontWeight:700, margin:0, fontSize:15, letterSpacing:1 }}>VyaparBot</p>
          <p style={{ color:"#5c5040", margin:0, fontSize:10, letterSpacing:2, textTransform:"uppercase" }}>AdiShila · Wholesale Assistant</p>
        </div>
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:5 }}>
          <div style={{ width:7,height:7,borderRadius:"50%",background:"#6fcf97" }}/>
          <span style={{ color:"#4a7a5c", fontSize:12 }}>Live · Sheets Connected</span>
        </div>
      </div>

      {/* ── Messages ─── */}
      <div style={{ flex:1, overflowY:"auto", padding:"18px 14px 6px", maxWidth:660, width:"100%", margin:"0 auto", boxSizing:"border-box" }}>
        {!started ? (
          <div style={{ textAlign:"center", paddingTop:"9vh" }}>
            <div style={{ fontSize:52, marginBottom:14 }}>🪨</div>
            <h1 style={{ color:"#c8a96e", fontSize:26, fontWeight:400, margin:"0 0 6px", letterSpacing:2 }}>AdiShila</h1>
            <p style={{ color:"#5c5040", fontSize:11, letterSpacing:4, textTransform:"uppercase", margin:"0 0 28px" }}>The Primordial Stone</p>
            <p style={{ color:"#8a7a65", fontSize:14, lineHeight:1.75, margin:"0 auto 36px", maxWidth:320 }}>
              Request samples, get bulk quotes, and place reorders for authentic Karelian shungite — directly saved to our team's CRM.
            </p>
            <button onClick={startChat} style={{
              background:"linear-gradient(135deg,#c8a96e,#8b6914)", border:"none",
              borderRadius:50, padding:"13px 34px", color:"#1a1206",
              fontWeight:700, fontSize:15, cursor:"pointer",
              fontFamily:"Georgia,serif", letterSpacing:1,
              boxShadow:"0 4px 22px rgba(200,169,110,0.22)",
            }}>Begin Enquiry →</button>
          </div>
        ) : (
          <>
            {msgs.map(msg => <div key={msg.id}>{renderMsg(msg)}</div>)}
            {typing && (
              <div style={{ display:"flex", alignItems:"flex-end", gap:8, marginBottom:10 }}>
                <div style={{ width:32,height:32,borderRadius:"50%",background:"linear-gradient(135deg,#c8a96e,#8b6914)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14 }}>🪨</div>
                <div style={{ background:"rgba(255,255,255,0.055)", border:"1px solid rgba(200,169,110,0.13)", borderRadius:"4px 16px 16px 16px", padding:"12px 16px", display:"flex", gap:5, alignItems:"center" }}>
                  {[0,1,2].map(i=><div key={i} style={{ width:7,height:7,borderRadius:"50%",background:"#c8a96e",animation:`pulse 1.2s ease-in-out ${i*0.2}s infinite` }}/>)}
                </div>
              </div>
            )}
            <div ref={bottomRef}/>
          </>
        )}
      </div>

      {/* ── Input bar ─── */}
      {started && !isDone && (
        <div style={{ background:"rgba(13,11,8,0.96)", borderTop:"1px solid rgba(200,169,110,0.14)", padding:"11px 14px", maxWidth:660, width:"100%", margin:"0 auto", boxSizing:"border-box", display:"flex", gap:9, alignItems:"center" }}>
          <input
            value={input}
            onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleSend()}
            placeholder="Type your response…"
            style={{ flex:1, background:"rgba(255,255,255,0.055)", border:"1px solid rgba(200,169,110,0.18)", borderRadius:50, padding:"10px 17px", color:"#e8dcc8", fontSize:14, fontFamily:"Georgia,serif", outline:"none" }}
          />
          <button onClick={()=>handleSend()} disabled={!input.trim()} style={{
            width:40,height:40,borderRadius:"50%",
            background: input.trim() ? "linear-gradient(135deg,#c8a96e,#8b6914)" : "rgba(255,255,255,0.05)",
            border:"none", color: input.trim() ? "#1a1206" : "#4a4030",
            fontSize:17, cursor: input.trim() ? "pointer" : "not-allowed",
            display:"flex",alignItems:"center",justifyContent:"center",
            transition:"all 0.18s", flexShrink:0,
          }}>→</button>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:.3;transform:scale(.85)} 50%{opacity:1;transform:scale(1)} }
        input::placeholder{color:#4a4030}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:rgba(200,169,110,0.18);border-radius:4px}
      `}</style>
    </div>
  );
}
