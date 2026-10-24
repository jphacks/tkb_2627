// Dev-only preview entry for U01: http://127.0.0.1:5173/src/screens/preview.html
// U01App is also the default screen of App.tsx (M1, #9); this entry renders it without the app shell.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { U01App } from './U01App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <U01App />
  </StrictMode>,
);
