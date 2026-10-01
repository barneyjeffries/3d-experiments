// HashRouter, not BrowserRouter: this app deploys to a GitHub Pages subpath
// (see vite.config.js `base`) as a static site with no server-side rewrites.
// A direct load or refresh on a nested route like /type-01 would 404 with
// history-based routing, since Pages has no route it can fall back from.
// Hash routing keeps every real request at "/" and does the routing client-side.
import { HashRouter, Routes, Route } from 'react-router-dom'
import Nav from './shared/Nav'
import Home from './pages/Home'
import Type01 from './experiments/Type01'
import Type02 from './experiments/Type02'
import Type03 from './experiments/Type03'
import Type04 from './experiments/Type04'
import Type05 from './experiments/Type05'
import Type06 from './experiments/Type06'
import Type07 from './experiments/Type07'
import Type08 from './experiments/Type08'

function App() {
  return (
    <HashRouter>
      <Nav />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/type-01" element={<Type01 />} />
        <Route path="/type-02" element={<Type02 />} />
        <Route path="/type-03" element={<Type03 />} />
        <Route path="/type-04" element={<Type04 />} />
        <Route path="/type-05" element={<Type05 />} />
        <Route path="/type-06" element={<Type06 />} />
        <Route path="/type-07" element={<Type07 />} />
        <Route path="/type-08" element={<Type08 />} />
      </Routes>
    </HashRouter>
  )
}

export default App
