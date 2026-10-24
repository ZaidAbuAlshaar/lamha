import { useEffect, useState } from 'react';
import Check from './Check';
import Doctor from './Doctor';
import ScanTest from './ScanTest';
import DevRecord from './DevRecord';
import Report from './Report';

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
  if (r.startsWith('/report/')) return <Report id={decodeURIComponent(r.slice('/report/'.length))} />;
  return <Check key={r} />;
}
