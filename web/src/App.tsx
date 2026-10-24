import { useEffect, useState } from 'react';
import Check from './Check';
import Doctor from './Doctor';
import ScanTest from './ScanTest';
import DevRecord from './DevRecord';
import Center from './Center';

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
  if (r.startsWith('/dev-record')) return <DevRecord />;
  if (r.startsWith('/center')) return <Center />;
  return <Check key={r} />;
}
