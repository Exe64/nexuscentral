/**
 * Routing and the providers every route needs.
 *
 * `/` renders the dashboard route, which redirects to the first dashboard once the
 * list loads (04-SPEC-frontend.md 1). Doing the redirect inside the page rather
 * than here keeps the "which dashboard is first" question in one place.
 */

import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthGate } from './components/AuthGate.tsx';
import { Layout } from './components/Layout.tsx';
import { I18nProvider } from './i18n.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Reader } from './pages/Reader.tsx';
import { Rules } from './pages/Rules.tsx';
import { Settings } from './pages/Settings.tsx';
import { Sources } from './pages/Sources.tsx';
import { Tags } from './pages/Tags.tsx';
import { ThemeProvider } from './theme/ThemeProvider.tsx';

export function App(): ReactNode {
  return (
    <I18nProvider>
      <ThemeProvider>
        {/*
          The gate sits outside the router: with no session there is no route
          worth resolving, and the theme still applies to the login screen.
        */}
        <AuthGate>
          <BrowserRouter>
            <Layout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/d/:dashboardId" element={<Dashboard />} />
                <Route path="/reader" element={<Reader />} />
                <Route path="/sources" element={<Sources />} />
                <Route path="/tags" element={<Tags />} />
                <Route path="/rules" element={<Rules />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
          </BrowserRouter>
        </AuthGate>
      </ThemeProvider>
    </I18nProvider>
  );
}
