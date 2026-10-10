import logo from '../assets/logo.png'

interface Preset {
  icon: string
  title: string
  desc: string
  /** 点击后填入输入框的指令(可带占位,用户再补细节) */
  prompt: string
}

/** 新会话上方的预制指令(skill 快捷入口)。贴合聚运赢运营场景。 */
const PRESETS: Preset[] = [
  {
    icon: '📊',
    title: '经营概览',
    desc: '汇总今天的实时销售额与销售预警',
    prompt: '打开管理面板,汇总今天的实时销售额、销售预警和各渠道数据,简要说明。'
  },
  {
    icon: '🎯',
    title: '销售目标',
    desc: '看本月各店铺目标完成情况',
    prompt: '打开目标跟踪,查看本月各店铺的销售目标完成情况,列出未达标的店铺。'
  },
  {
    icon: '🛒',
    title: '商品表现',
    desc: '最近 7 天卖得最好的商品 / 店铺',
    prompt: '在运营报表里查最近 7 天销售额最高的商品和店铺,各列前 10。'
  },
  {
    icon: '📁',
    title: '导出报表',
    desc: '把当前报表整理导出成文件',
    prompt: '把当前报表的数据整理成 CSV 并导出成文件供我下载。'
  }
]

interface Props {
  onPick: (prompt: string) => void
}

/** 新会话欢迎页:图标 + 标题 + 预制指令卡片 */
export default function WelcomeHero({ onPick }: Props) {
  return (
    <div className="welcome">
      <div className="welcome-logo">
        <img src={logo} alt="聚运赢" width={44} height={44} />
      </div>
      <div className="welcome-title">让 Agent 帮你操作聚运赢</div>
      <div className="welcome-sub">选一个开始,或直接描述你的需求</div>

      <div className="welcome-presets">
        {PRESETS.map((p) => (
          <button key={p.title} className="preset-card" onClick={() => onPick(p.prompt)}>
            <span className="preset-icon">{p.icon}</span>
            <span className="preset-text">
              <span className="preset-title">{p.title}</span>
              <span className="preset-desc">{p.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
