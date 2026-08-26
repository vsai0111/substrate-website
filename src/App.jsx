import Navbar from './sections/Navbar'
import Hero from './sections/Hero'
import Terminal from './sections/Terminal'
import Projects from './sections/Projects'
import About from './sections/About'
import Experiments from './sections/Experiments'
import Capabilities from './sections/Capabilities'
import Process from './sections/Process'
import CTA from './sections/CTA'
import Footer from './sections/Footer'

export default function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <Navbar />

      <main id="main">
        <Hero />
        <Terminal />
        <Projects />
        <About />
        <Experiments />
        <Capabilities />
        <Process />
        <CTA />
      </main>

      <Footer />
    </>
  )
}
