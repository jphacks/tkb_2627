// Dev-only preview entry for U01: http://127.0.0.1:5173/src/screens/preview.html
// App.tsx is untouched; wiring U01App into the app is an M1 decision.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { U01App } from './U01App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <U01App />
  </StrictMode>,
);
