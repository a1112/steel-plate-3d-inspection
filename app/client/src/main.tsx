import { createRoot } from 'react-dom/client';
import App from './App';
import { FullscreenShortcut } from './components/FullscreenShortcut';
import { NotificationCenter } from './components/NotificationCenter';

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <FullscreenShortcut />
    <NotificationCenter />
  </>,
);
