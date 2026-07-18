import { createRoot } from 'react-dom/client';
import App from './App';
import { FullscreenShortcut } from './components/FullscreenShortcut';
import { NotificationCenter } from './components/NotificationCenter';
import { readStoredTheme } from './state/inspection-ui';

document.documentElement.dataset.theme = readStoredTheme();
const appMode = new URLSearchParams(window.location.search).get('app');
const usesStandaloneNotificationCenter = appMode === 'bar-surface' || appMode === 'bar' || appMode === '3d' || appMode === 'reconstruction';

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <FullscreenShortcut />
    {usesStandaloneNotificationCenter ? <NotificationCenter /> : null}
  </>,
);
