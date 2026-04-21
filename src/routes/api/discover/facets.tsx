import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/discover/facets')({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/api/discover/facets"!</div>
}
