import LiquidEther from './LiquidEther'
import BlurText from './BlurText'
import './LandingPage.css'

interface LandingPageProps {
  onEnter: () => void
}

export default function LandingPage({ onEnter }: LandingPageProps) {
  const handleClick = () => {
    setTimeout(() => {
      onEnter()
    }, 300)
  }

  const handleAnimationComplete = () => {
    // Animation completed
  }

  return (
    <div className="landing-page" onClick={handleClick}>
      {/* Liquid Ether Background */}
      <div className="liquid-ether-wrapper">
        <LiquidEther
          colors={['#5227FF', '#FF9FFC', '#B19EEF', '#a78bfa']}
          mouseForce={20}
          cursorSize={100}
          isViscous={false}
          viscous={30}
          iterationsViscous={32}
          iterationsPoisson={32}
          resolution={0.5}
          isBounce={false}
          autoDemo={true}
          autoSpeed={0.5}
          autoIntensity={2.2}
          takeoverDuration={0.25}
          autoResumeDelay={3000}
          autoRampDuration={0.6}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0 }}
        />
      </div>

      {/* Main Content - Centered Blur Text */}
      <div className="landing-content">
        <BlurText
          text="SNITCH THE WITCH"
          delay={150}
          animateBy="words"
          direction="top"
          onAnimationComplete={handleAnimationComplete}
          className="blur-text-title"
        />
      </div>
    </div>
  )
}

