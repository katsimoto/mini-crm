import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// A restored document may belong to a session that has since signed out in another tab.
window.addEventListener('pageshow', event => {
  if (event.persisted) window.location.reload();
});
