import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans-condensed/400.css';
import '@fontsource/ibm-plex-sans-condensed/500.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@xyflow/react/dist/style.css';
import 'dockview-react/dist/styles/dockview.css';
import './canvas/tokens.css';
import './canvas/canvas.css';
import './canvas/art.css';
import './dock/dock.css';
import './panels/panels.css';
import './chat/chat.css';
import './app/document.css';
import './app.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
