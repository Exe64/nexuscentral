/**
 * Routing.
 *
 * `/` redirects to `/reader` for now. The spec has it redirect to the first
 * dashboard (04-SPEC-frontend.md 1); dashboards arrive in Phase 5, and until then
 * the reader is the only surface that shows anything.
 */

import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout.tsx';
import { I18nProvider } from './i18n.tsx';
import { Reader } from './pages/Reader.tsx';
import { Rules } from './pages/Rules.tsx';
import { Settings } from './pages/Settings.tsx';
import { Sources } from './pages/Sources.tsx';
import { Tags } from './pages/Tags.tsx';

export function App(): ReactNode {
  return (
    <I18nProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Navigate to="/reader" replace />} />
            <Route path="/reader" element={<Reader />} />
            <Route path="/sources" element={<Sources />} />
            <Route path="/tags" element={<Tags />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/reader" replace />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </I18nProvider>
  );
}
