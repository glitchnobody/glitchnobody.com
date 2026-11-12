import {
  HeadContent,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import appCss from '../styles.css?url'

// Light unless dark was chosen (Alt/Option + D); set before paint so there is no flash.
const THEME_INIT_SCRIPT = `try{if(localStorage.getItem('theme')==='dark'){document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark'}}catch(e){}`

const SITE = 'https://glitchnobody.com'
const TITLE = 'GlitchNobody — Siddhant Vij, Product Designer and Developer'
const DESCRIPTION = 'Creating products that make people think, “Why didn’t this exist before?”'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      { title: TITLE },
      { name: 'description', content: DESCRIPTION },
      { name: 'author', content: 'Siddhant Vij' },
      { name: 'theme-color', content: '#fafafa' },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'GlitchNobody' },
      { property: 'og:title', content: TITLE },
      { property: 'og:description', content: DESCRIPTION },
      { property: 'og:url', content: SITE },
      { property: 'og:image', content: `${SITE}/og.png` },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'og:image:alt', content: 'Siddhant Vij — Make Products Feel Amazing' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: TITLE },
      { name: 'twitter:description', content: DESCRIPTION },
      { name: 'twitter:image', content: `${SITE}/og.png` },
    ],
    links: [
      { rel: 'canonical', href: `${SITE}/` },
      // .ico first as the default; the PNGs cover search results, iOS home screens and Android
      { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
      { rel: 'icon', href: '/favicon-96x96.png', type: 'image/png', sizes: '96x96' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
      { rel: 'manifest', href: '/site.webmanifest' },
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased [overflow-wrap:anywhere]">
        {children}
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
