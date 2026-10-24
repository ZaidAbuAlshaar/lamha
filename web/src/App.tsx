import { useEffect, useState } from 'react';
import Check from './Check';
import Doctor from './Doctor';
import ScanTest from './ScanTest';

function route() {
  return window.location.hash.replace(/^#/, '').split('?')[0] || '/';
}

export default function App() {
  const [r, setR] = useState(route());
  useEffect(() => {
    const on = () => setR(route());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  if (r.startsWith('/doctor')) return <Doctor />;
  if (r.startsWith('/scan-test')) return <ScanTest />;
  return <Check key={r} />;
}
