import './styles/index.css'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'

import { App } from './App'
import { installInteractionTracking } from './lib/interaction'
import { applyTheme } from './lib/theme'
import { RealtimeProvider } from './realtime/RealtimeProvider'

applyTheme()
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  applyTheme()
})
installInteractionTracking()

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
})

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RealtimeProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </RealtimeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
