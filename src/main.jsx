import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import { confirmSignIn, fetchAuthSession, getCurrentUser, signIn, signOut } from 'aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito';
import { sessionStorage } from 'aws-amplify/utils';
import './styles.css';

let cloudAuth = false;

const categories = ['Pantry', 'Produce', 'Dairy', 'Frozen', 'Beverages', 'Snacks', 'Other'];
const api = async (path, options = {}) => {
  const session = cloudAuth ? await fetchAuthSession() : null;
  const token = session?.tokens?.idToken?.toString();
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
};
const shortDate = value => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));

function ProductDialog({ onClose, onSave, initialBarcode = '', pendingCount = 0, pendingDelta }) {
  const startingQuantity = pendingDelta === undefined ? Math.max(1, pendingCount) : Math.max(0, pendingDelta);
  const [form, setForm] = useState({ barcode: initialBarcode, name: '', brand: '', category: 'Pantry', location: 'Pantry', quantity: startingQuantity, unit: 'item' });
  const [lookup, setLookup] = useState('');
  const set = (key, value) => setForm(old => ({ ...old, [key]: value }));
  async function findProduct() {
    if (!form.barcode.trim()) return setLookup('Enter a barcode first.');
    setLookup('Looking up product…');
    try {
      const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(form.barcode.trim())}.json?fields=product_name,brands,categories`);
      const data = await response.json();
      if (data.status !== 1 || !data.product) return setLookup('No match found. Add the details manually.');
      const product = data.product;
      setForm(old => ({ ...old, name: product.product_name || old.name, brand: product.brands || old.brand, category: chooseCategory(product.categories, old.category) }));
      setLookup('Product details found. Please review them.');
    } catch { setLookup('Lookup unavailable. You can still enter the details manually.'); }
  }
  return <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <form className="dialog" onSubmit={e => { e.preventDefault(); onSave(form); }}>
      <div className="dialog-top"><div><span className="eyebrow">YOUR PANTRY</span><h2>Add a food</h2></div><button type="button" className="close-btn" onClick={onClose} aria-label="Close">×</button></div>
      <p className="muted">Save it once, then every scan can update its quantity.</p>
      <label>Barcode <div className="lookup-row"><input value={form.barcode} onChange={e => set('barcode', e.target.value)} placeholder="Scan or enter a barcode" /><button className="button button-light" type="button" onClick={findProduct}>Look up</button></div></label>
      {lookup && <div className="lookup-note">{lookup}</div>}
      <label>Food name<input required autoFocus value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Rolled oats" /></label>
      <div className="form-grid"><label>Brand<input value={form.brand} onChange={e => set('brand', e.target.value)} placeholder="Optional" /></label><label>Category<select value={form.category} onChange={e => set('category', e.target.value)}>{categories.map(c => <option key={c}>{c}</option>)}</select></label></div>
      <div className="form-grid"><label>Starting amount<input type="number" min="0" step="1" value={form.quantity} onChange={e => set('quantity', e.target.value)} /></label><label>Unit<input value={form.unit} onChange={e => set('unit', e.target.value)} placeholder="item, bag, jar…" /></label></div>
      <label>Stored in<input value={form.location} onChange={e => set('location', e.target.value)} /></label>
      <div className="dialog-actions"><button type="button" className="button button-light" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit">Save food</button></div>
    </form>
  </div>;
}

function SignInGate({ children }) {
  const [user, setUser] = useState(undefined);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [challenge, setChallenge] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    fetch('/runtime-config.json').then(response => response.ok ? response.json() : null).catch(() => null).then(config => {
      if (config?.userPoolId && config?.userPoolClientId) {
        cloudAuth = true;
        Amplify.configure({ Auth: { Cognito: { userPoolId: config.userPoolId, userPoolClientId: config.userPoolClientId, loginWith: { email: true } } } });
        cognitoUserPoolsTokenProvider.setKeyValueStorage(sessionStorage);
        return getCurrentUser().then(setUser).catch(() => setUser(null));
      }
      setUser(null);
    }).catch(() => setUser(null));
    return () => { active = false; };
  }, []);
  if (user === undefined) return <div className="auth-loading">Opening your pantry…</div>;
  if (!cloudAuth) return children;
  async function submit(event) {
    event.preventDefault(); setMessage('');
    try {
      if (challenge) {
        await confirmSignIn({ challengeResponse: newPassword });
        setUser(await getCurrentUser()); setChallenge(false); return;
      }
      const result = await signIn({ username: email.trim(), password });
      if (result.isSignedIn) setUser(await getCurrentUser());
      else if (result.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') setChallenge(true);
      else setMessage('This sign-in step is not supported yet. Contact the person who set up the pantry.');
    } catch (error) { setMessage(error.message || 'Could not sign in.'); }
  }
  if (user) return <>{React.cloneElement(children, { signedInEmail: user.signInDetails?.loginId || user.username, onSignOut: async () => { await signOut(); setUser(null); } })}</>;
  return <main className="auth-screen"><form className="auth-card" onSubmit={submit}><div className="brand"><div className="brand-mark">P</div><span>pantry<span className="brand-dot">.</span></span></div><h1>{challenge ? 'Choose a new password' : 'Welcome back'}</h1><p>Sign in to see your household inventory.</p>{!challenge && <><label>Email<input type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} /></label><label>Password<input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label></>}{challenge && <label>New password<input type="password" required autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} /></label>}{message && <div className="error-banner">{message}</div>}<button className="button button-primary" type="submit">{challenge ? 'Save password' : 'Sign in'}</button></form></main>;
}

function chooseCategory(value, fallback) {
  const text = String(value || '').toLowerCase();
  for (const c of categories) if (text.includes(c.toLowerCase())) return c;
  if (text.includes('dairy') || text.includes('milk') || text.includes('cheese')) return 'Dairy';
  if (text.includes('frozen')) return 'Frozen';
  if (text.includes('beverage') || text.includes('drink')) return 'Beverages';
  if (text.includes('snack')) return 'Snacks';
  return fallback || 'Other';
}

function CameraDialog({ onClose, onScan }) {
  const video = useRef(null);
  const [message, setMessage] = useState('Starting camera…');
  useEffect(() => {
    let stream;
    let active = true;
    let timer;
    (async () => {
      if (!('BarcodeDetector' in window)) return setMessage('Barcode detection is not supported in this browser. Use the scan field or manual entry instead.');
      try {
        const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (!active) return stream.getTracks().forEach(track => track.stop());
        video.current.srcObject = stream;
        await video.current.play();
        setMessage('Point the camera at a barcode');
        timer = window.setInterval(async () => {
          if (!active || !video.current || video.current.readyState < 2) return;
          try {
            const codes = await detector.detect(video.current);
            if (codes.length && codes[0].rawValue) { active = false; onScan(codes[0].rawValue); }
          } catch { /* Keep scanning while the camera focuses. */ }
        }, 280);
      } catch { setMessage('Camera access was unavailable. Check browser permission or use the scan field.'); }
    })();
    return () => { active = false; window.clearInterval(timer); stream?.getTracks().forEach(track => track.stop()); };
  }, [onScan]);
  return <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}><section className="dialog camera-dialog"><div className="dialog-top"><div><span className="eyebrow">CAMERA SCAN</span><h2>Scan a barcode</h2></div><button className="close-btn" onClick={onClose}>×</button></div><video ref={video} muted playsInline/><div className="scan-frame"/><p className="camera-message">{message}</p></section></div>;
}

function App({ signedInEmail, onSignOut }) {
  const [data, setData] = useState({ products: [], events: [], pendingScans: [] });
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All foods');
  const [action, setAction] = useState('add');
  const [barcode, setBarcode] = useState('');
  const [dialog, setDialog] = useState(null);
  const [toast, setToast] = useState('');
  const scanInput = useRef(null);
  const refresh = async () => setData(await api('/api/state'));
  useEffect(() => { refresh().catch(() => setError('Could not connect to the inventory server. Start the app server and try again.')); }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2600); return () => clearTimeout(t); }, [toast]);
  const filtered = useMemo(() => data.products.filter(p => (category === 'All foods' || p.category === category) && `${p.name} ${p.brand} ${p.barcode} ${p.location}`.toLowerCase().includes(query.toLowerCase())), [data.products, category, query]);
  const total = data.products.reduce((sum, p) => sum + Number(p.quantity || 0), 0);
  const low = data.products.filter(p => p.quantity > 0 && p.quantity <= 2).length;
  async function scan(code, mode = action) {
    const clean = String(code || '').replace(/\s/g, '');
    if (!clean) return;
    setError('');
    try {
      const result = await api('/api/scans', { method: 'POST', body: JSON.stringify({ barcode: clean, action: mode, source: 'app' }) });
      await refresh();
      if (result.status === 'needs_product') {
        setDialog({ type: 'product', barcode: clean, pendingCount: result.pending.count, pendingDelta: result.pending.delta });
        setToast('New barcode saved for product setup');
      } else setToast(mode === 'remove' ? `${result.product.name} removed` : `${result.product.name} added`);
    } catch (e) { setError(e.message); }
    setBarcode('');
  }
  async function changeStock(product, delta) {
    try { await api('/api/stock', { method: 'POST', body: JSON.stringify({ productId: product.id, delta }) }); await refresh(); setToast(delta > 0 ? `${product.name} added` : `${product.name} removed`); }
    catch (e) { setError(e.message); }
  }
  async function saveProduct(form) {
    try { await api('/api/products', { method: 'POST', body: JSON.stringify(form) }); await refresh(); setDialog(null); setToast(`${form.name} saved`); }
    catch (e) { setError(e.message); }
  }
  const cameraScan = React.useCallback(code => { setDialog(null); scan(code); }, [action, data.pendingScans]);
  const latest = data.events.slice(0, 5);
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark">P</div><span>pantry<span className="brand-dot">.</span></span></div><div className="side-label">YOUR HOME</div><button className="nav-item active"><span>▦</span> Inventory <b>{data.products.length}</b></button><button className="nav-item" onClick={() => document.getElementById('recent')?.scrollIntoView({ behavior: 'smooth' })}><span>◷</span> Recent activity</button><div className="sidebar-bottom"><div className="server-status"><span className="status-dot"/><div><strong>Inventory saved</strong><small>{cloudAuth ? 'Shared household' : 'On this Mac'}</small></div></div>{signedInEmail && <button className="signout-button" onClick={onSignOut}>Sign out · {signedInEmail}</button>}<div className="sidebar-note">A little more organized,<br/>one scan at a time.</div></div></aside>
    <main className="main"><header className="topbar"><div className="mobile-brand"><span className="brand-mark">P</span> pantry<span className="brand-dot">.</span></div><div className="topbar-right"><span className="date-label">YOUR KITCHEN INVENTORY</span><button className="avatar">A</button></div></header>
      <div className="content"><div className="welcome-row"><div><div className="eyebrow">HOME INVENTORY</div><h1>Your pantry, <em>at a glance.</em></h1><p className="subtitle">Keep track of what you have and what’s running low.</p></div><div className="welcome-art" aria-hidden="true"><span>🥬</span><span>🥫</span><span>🍋</span></div></div>
        <section className="scan-panel"><div className="scan-copy"><div className="scan-icon">⌕</div><div><h2>Quick scan</h2><p>Scan a barcode or enter it below to update stock.</p></div></div><div className="scan-actions"><div className="segmented"><button className={action === 'add' ? 'selected' : ''} onClick={() => setAction('add')}>＋ Add</button><button className={action === 'remove' ? 'selected remove-selected' : ''} onClick={() => setAction('remove')}>− Remove</button></div><button className="button button-camera" onClick={() => setDialog({ type: 'camera' })}><span>▣</span> Camera</button></div><form className="scan-form" onSubmit={e => { e.preventDefault(); scan(barcode); }}><span className="input-scan-icon">⌕</span><input ref={scanInput} value={barcode} onChange={e => setBarcode(e.target.value)} placeholder="Scan barcode or type it here…" aria-label="Barcode"/><button type="submit" className="button button-dark">{action === 'add' ? 'Add item' : 'Remove item'} <span>↗</span></button></form><div className="scan-hint"><span className="kbd">↵</span> A connected USB or Bluetooth scanner types here and presses Enter.</div></section>
        {error && <div className="error-banner">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
        <div className="stats-grid"><div className="stat-card"><div className="stat-top"><span>ITEMS IN STOCK</span><span className="stat-icon green">▤</span></div><strong>{total}</strong><small>across {data.products.length} foods</small></div><div className="stat-card"><div className="stat-top"><span>FOODS TRACKED</span><span className="stat-icon yellow">◉</span></div><strong>{data.products.length}</strong><small>unique products</small></div><div className="stat-card"><div className="stat-top"><span>RUNNING LOW</span><span className="stat-icon peach">⌄</span></div><strong>{low}</strong><small>{low ? '2 or fewer in stock' : 'you’re all stocked up'}</small></div><div className="stat-card tip-card"><div className="tip-star">✳</div><div><strong>Small steps add up.</strong><p>Scan groceries as they come in, and your pantry stays in sync.</p></div></div></div>
        <section className="inventory-section"><div className="section-head"><div><div className="eyebrow">THE SHELVES</div><h2>Your foods <span className="count-pill">{filtered.length}</span></h2></div><button className="button button-primary" onClick={() => setDialog({ type: 'product', barcode: '' })}><span>＋</span> Add food</button></div><div className="toolbar"><div className="search-wrap"><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search your pantry"/></div><div className="filter-wrap"><span>Category</span><select value={category} onChange={e => setCategory(e.target.value)}><option>All foods</option>{categories.map(c => <option key={c}>{c}</option>)}</select></div></div>
          {data.pendingScans.length > 0 && <div className="pending-box"><div><strong>{data.pendingScans.length} barcode{data.pendingScans.length > 1 ? 's' : ''} need product details</strong><p>We’ve saved these scans. Add a name so future scans update stock automatically.</p></div><div className="pending-list">{data.pendingScans.slice(0, 3).map(item => <button key={item.id} onClick={() => setDialog({ type: 'product', barcode: item.barcode, pendingCount: item.count, pendingDelta: item.delta })}><code>{item.barcode}</code><span>{item.count} scan{item.count === 1 ? '' : 's'} · Add details →</span></button>)}</div></div>}
          {filtered.length === 0 ? <div className="empty-state"><div className="empty-illustration">🥣</div><h3>{query || category !== 'All foods' ? 'No foods found' : 'Your pantry is ready'}</h3><p>{query || category !== 'All foods' ? 'Try another search or category.' : 'Add your first food, or scan a barcode to get started.'}</p>{!data.products.length && <button className="button button-primary" onClick={() => setDialog({ type: 'product', barcode: '' })}>＋ Add your first food</button>}</div> : <div className="product-list"><div className="list-heading"><span>FOOD</span><span>LOCATION</span><span>IN STOCK</span><span>UPDATE</span></div>{filtered.map((product, i) => <article className="product-row" key={product.id}><div className="food-cell"><div className={`food-emoji tone-${i % 5}`}>{foodEmoji(product.category)}</div><div><strong>{product.name}</strong><small>{[product.brand, product.category, product.barcode].filter(Boolean).join(' · ')}</small></div></div><div className="location-cell"><span className="pin">⌖</span>{product.location}</div><div className="quantity-cell"><strong>{product.quantity}</strong><small>{product.unit}{product.quantity === 1 ? '' : 's'}</small>{product.quantity > 0 && product.quantity <= 2 && <span className="low-badge">LOW</span>}</div><div className="row-actions"><button aria-label={`Remove one ${product.name}`} onClick={() => changeStock(product, -1)}>−</button><button aria-label={`Add one ${product.name}`} onClick={() => changeStock(product, 1)}>＋</button></div></article>)}</div>}
        </section>
        <section className="recent-section" id="recent"><div className="section-head compact-head"><div><div className="eyebrow">JUST HAPPENED</div><h2>Recent activity</h2></div><span className="muted">Latest 5 updates</span></div>{latest.length ? <div className="activity-list">{latest.map(event => <div className="activity-row" key={event.id}><span className={`activity-symbol ${event.delta >= 0 ? 'plus' : 'minus'}`}>{event.delta >= 0 ? '＋' : '−'}</span><div><strong>{event.productName}</strong><small>{event.source === 'scanner' ? 'Scanner' : event.source === 'setup' ? 'Initial stock' : 'Inventory update'} · {shortDate(event.at)}</small></div><b className={event.delta >= 0 ? 'delta-positive' : 'delta-negative'}>{event.delta > 0 ? '+' : ''}{event.delta}</b></div>)}</div> : <div className="activity-empty">Stock changes will show up here.</div>}</section>
        <footer>Made for the everyday rhythm of a home kitchen <span>✳</span></footer>
      </div>
    </main>
    {dialog?.type === 'product' && <ProductDialog initialBarcode={dialog.barcode} pendingCount={dialog.pendingCount} pendingDelta={dialog.pendingDelta} onClose={() => setDialog(null)} onSave={saveProduct}/>}
    {dialog?.type === 'camera' && <CameraDialog onClose={() => setDialog(null)} onScan={cameraScan}/>}
    {toast && <div className="toast"><span>✓</span>{toast}</div>}
  </div>;
}

function foodEmoji(category) { return ({ Pantry: '🌾', Produce: '🥬', Dairy: '🥛', Frozen: '🧊', Beverages: '🧃', Snacks: '🥨', Other: '🥣' })[category] || '🥣'; }

createRoot(document.getElementById('root')).render(<React.StrictMode><SignInGate><App/></SignInGate></React.StrictMode>);
