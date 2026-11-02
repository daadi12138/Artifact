import type { Metadata } from 'next'
import './gridscape.css'
import { GridscapeCanvas } from './GridscapeCanvas'

export const metadata: Metadata = {
  title: 'GRIDSCAPE · Artifact',
  description: 'Explore interconnected concepts on an infinite spatial canvas',
}

export default function GridscapeRoute() {
  return <GridscapeCanvas />
}
