'use client'

import React, { useState } from 'react'
import { X, Sparkles, ArrowRight, Check, LayoutGrid, Terminal, Gauge, Sparkle } from 'lucide-react'

export interface DesignProposal {
  id: string
  title: string
  subtitle: string
  category: string
  description: string
  highlights: string[]
  theme: string
}

export const DESIGN_PROPOSALS: DesignProposal[] = [
  {
    id: 'proposal-1',
    title: '方案一：开发者工作台 (IDE-Style)',
    subtitle: 'VSCode / JetBrains 风格的高密度工作区',
    category: '专业效率型',
    description: '采用类似经典 IDE 的三栏双翼布局。左侧为精简的项目与工作流导航，中央为主操作画布，右侧为全属性检查器，底部支持抽屉式终端与日志面板。适合追求键盘流与高信息密度的工程师。',
    highlights: [
      '极高信息密度，主视图零跳页',
      '底部可折叠/拖拽式实时 Agent 终端与日志抽屉',
      '右侧节点属性检查器支持参数即改即生效',
      '深色专业低对比度主题，长时间使用不伤眼'
    ],
    theme: 'Dark Navy / Slate'
  },
  {
    id: 'proposal-2',
    title: '方案二：流水线驾驶舱 (Pipeline Cockpit)',
    subtitle: 'CI/CD 自动化流水线与代码审查控制台',
    category: '流程式管控',
    description: '强调任务流经的状态与质量把控。顶部展示全局流水线运行指标与步骤耗时；主界面由清晰的横向 DAG 节点图、右侧实时产物与代码 Diff 预览、以及底部人工审批栏构成。适合团队协作与自动化管控。',
    highlights: [
      '顶部实时运行总览、状态卡片与成功率统计',
      '内置代码变更 Diff 预览器与 Artifact 产物查看器',
      '显式的人工介入与命令授权审批条',
      '明晰的步骤状态流转与重试机制'
    ],
    theme: 'Modern Clean Slate'
  },
  {
    id: 'proposal-3',
    title: '方案三：一体化流程枢纽 (Unified Studio)',
    subtitle: '现代化轻量、通透的无边界画布中心',
    category: '沉浸式创新',
    description: '彻底去掉繁琐的多层侧边栏，改为顶部水平轻量导航条。中央全屏沉浸式无边框画布，所有工具栏采用悬浮 Dock 形式，右侧采用毛玻璃抽屉。视觉轻盈现代化，操作极其流畅自然。',
    highlights: [
      '顶部极简水平导航，释放 100% 垂直与水平视口',
      '悬浮式快捷操作 Dock (运行、对齐、缩放、添加)',
      '通透且柔和的现代 UI，无压抑感',
      '轻量抽屉与平滑过渡动画'
    ],
    theme: 'Minimalist Frost & Indigo'
  }
]

export function DesignProposalsModal({
  isOpen,
  onClose,
  selectedProposal,
  onSelectProposal,
  onApplyProposal,
}: {
  isOpen: boolean
  onClose: () => void
  selectedProposal: string
  onSelectProposal: (id: string) => void
  onApplyProposal?: (id: string) => void
}) {
  const [activeTab, setActiveTab] = useState<string>(selectedProposal || 'proposal-1')

  if (!isOpen) return null

  const current = DESIGN_PROPOSALS.find(p => p.id === activeTab) || DESIGN_PROPOSALS[0]

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: '100vh',
        backgroundColor: 'rgba(15, 23, 42, 0.8)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        zIndex: 999999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        boxSizing: 'border-box',
      }}
      onClick={onClose}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '920px',
          maxHeight: '88vh',
          backgroundColor: '#0f172a',
          color: '#f8fafc',
          border: '1px solid #334155',
          borderRadius: '12px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.6)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: 'inherit',
          boxSizing: 'border-box',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            backgroundColor: '#090d16',
            borderBottom: '1px solid #1e293b',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                backgroundColor: 'rgba(99, 102, 241, 0.15)',
                color: '#818cf8',
                border: '1px solid rgba(99, 102, 241, 0.3)',
              }}
            >
              <Sparkles style={{ width: '18px', height: '18px' }} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#f8fafc' }}>
                系统界面重构方案选择
              </h2>
              <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#94a3b8' }}>
                点击不同方案标签可切换查看架构效果与设计说明
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '30px',
              height: '30px',
              borderRadius: '6px',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              color: '#94a3b8',
              cursor: 'pointer',
            }}
          >
            <X style={{ width: '16px', height: '16px' }} />
          </button>
        </div>

        {/* 3 Tabs Selection */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '10px',
            padding: '14px 20px',
            backgroundColor: '#020617',
            borderBottom: '1px solid #1e293b',
          }}
        >
          {DESIGN_PROPOSALS.map((p) => {
            const isSelected = activeTab === p.id
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setActiveTab(p.id)
                  onSelectProposal(p.id)
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  textAlign: 'left',
                  padding: '12px 14px',
                  borderRadius: '8px',
                  border: isSelected ? '1px solid #6366f1' : '1px solid #334155',
                  backgroundColor: isSelected ? 'rgba(49, 46, 129, 0.45)' : '#0f172a',
                  cursor: 'pointer',
                  transition: 'all 150ms ease',
                  boxShadow: isSelected ? '0 0 0 1px #6366f1' : 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: '6px' }}>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '10px',
                      fontWeight: 600,
                      backgroundColor: isSelected ? 'rgba(99, 102, 241, 0.3)' : '#1e293b',
                      color: isSelected ? '#a5b4fc' : '#cbd5e1',
                    }}
                  >
                    {p.category}
                  </span>
                  {isSelected && (
                    <span style={{ fontSize: '11px', color: '#818cf8', display: 'flex', alignItems: 'center', gap: '2px' }}>
                      <Check style={{ width: '12px', height: '12px' }} /> 选定
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#f1f5f9', marginBottom: '2px' }}>
                  {p.title}
                </div>
                <div style={{ fontSize: '11px', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.subtitle}
                </div>
              </button>
            )
          })}
        </div>

        {/* Modal Body */}
        <div style={{ flex: 1, padding: '20px', overflowY: 'auto', backgroundColor: '#0b0f19' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '20px', alignItems: 'stretch' }}>
            {/* Visual preview box */}
            <div
              style={{
                backgroundColor: '#020617',
                border: '1px solid #1e293b',
                borderRadius: '8px',
                padding: '14px',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '12px',
                  paddingBottom: '8px',
                  borderBottom: '1px solid #1e293b',
                  fontSize: '11px',
                  color: '#94a3b8',
                }}
              >
                <span>布局线框图 · {current.title}</span>
                <span style={{ color: '#38bdf8' }}>{current.theme}</span>
              </div>

              {current.id === 'proposal-1' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, minHeight: '190px' }}>
                  {/* Mock topbar */}
                  <div style={{ height: '22px', backgroundColor: '#1e293b', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px', fontSize: '9px', color: '#94a3b8' }}>
                    <span>artifact / project-core / workflow</span>
                    <span style={{ color: '#34d399' }}>Runtime Ready</span>
                  </div>
                  {/* Middle 3 columns */}
                  <div style={{ display: 'grid', gridTemplateColumns: '85px 1fr 95px', gap: '6px', flex: 1 }}>
                    <div style={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '4px', padding: '6px', fontSize: '9px' }}>
                      <div style={{ color: '#64748b', fontWeight: 600, marginBottom: '4px' }}>EXPLORER</div>
                      <div style={{ color: '#94a3b8', lineHeight: '1.8' }}>
                        <div style={{ backgroundColor: '#1e293b', padding: '2px 4px', borderRadius: '2px', color: '#a5b4fc' }}>▶ 需求分析</div>
                        <div style={{ padding: '2px 4px' }}>▶ 架构设计</div>
                        <div style={{ padding: '2px 4px' }}>▶ 编码 Agent</div>
                        <div style={{ padding: '2px 4px' }}>▶ 测试交付</div>
                      </div>
                    </div>
                    <div style={{ backgroundColor: '#020617', border: '1px solid #4f46e5', borderRadius: '4px', padding: '8px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                      <div style={{ fontSize: '9px', color: '#818cf8', fontWeight: 600 }}>CANVAS / GRAPH</div>
                      <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center' }}>
                        <span style={{ padding: '3px 6px', backgroundColor: '#1e293b', borderRadius: '3px', fontSize: '9px' }}>Spec</span>
                        <span style={{ color: '#64748b', fontSize: '10px' }}>➔</span>
                        <span style={{ padding: '3px 6px', backgroundColor: '#312e81', border: '1px solid #6366f1', borderRadius: '3px', fontSize: '9px', color: '#c7d2fe' }}>Agent</span>
                        <span style={{ color: '#64748b', fontSize: '10px' }}>➔</span>
                        <span style={{ padding: '3px 6px', backgroundColor: '#064e3b', borderRadius: '3px', fontSize: '9px', color: '#6ee7b7' }}>Verify</span>
                      </div>
                      <div style={{ fontSize: '9px', color: '#64748b' }}>Zoom: 100% · Drag to pan</div>
                    </div>
                    <div style={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '4px', padding: '6px', fontSize: '9px' }}>
                      <div style={{ color: '#64748b', fontWeight: 600, marginBottom: '4px' }}>INSPECTOR</div>
                      <div style={{ color: '#cbd5e1', lineHeight: '1.6', fontSize: '8.5px' }}>
                        <div>Node: Agent</div>
                        <div>Model: Claude 3.5</div>
                        <div>Output: schema</div>
                      </div>
                    </div>
                  </div>
                  {/* Bottom terminal */}
                  <div style={{ height: '36px', backgroundColor: '#020617', border: '1px solid #1e293b', borderRadius: '4px', padding: '4px 8px', fontSize: '8.5px', color: '#34d399', fontFamily: 'monospace' }}>
                    <div>[Runner] Node: Codex Agent execution active...</div>
                    <div style={{ color: '#64748b' }}>[Worktree] /sandbox-01 isolated worktree ready</div>
                  </div>
                </div>
              )}

              {current.id === 'proposal-2' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, minHeight: '190px' }}>
                  {/* Top stats */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
                    <div style={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', padding: '4px', borderRadius: '4px', textAlign: 'center' }}>
                      <div style={{ fontSize: '8px', color: '#64748b' }}>STATUS</div>
                      <div style={{ fontSize: '10px', color: '#34d399', fontWeight: 600 }}>RUNNING</div>
                    </div>
                    <div style={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', padding: '4px', borderRadius: '4px', textAlign: 'center' }}>
                      <div style={{ fontSize: '8px', color: '#64748b' }}>STEPS</div>
                      <div style={{ fontSize: '10px', color: '#f8fafc', fontWeight: 600 }}>3 / 4</div>
                    </div>
                    <div style={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', padding: '4px', borderRadius: '4px', textAlign: 'center' }}>
                      <div style={{ fontSize: '8px', color: '#64748b' }}>DURATION</div>
                      <div style={{ fontSize: '10px', color: '#f8fafc', fontWeight: 600 }}>1m 12s</div>
                    </div>
                    <div style={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', padding: '4px', borderRadius: '4px', textAlign: 'center' }}>
                      <div style={{ fontSize: '8px', color: '#64748b' }}>APPROVAL</div>
                      <div style={{ fontSize: '10px', color: '#fbbf24', fontWeight: 600 }}>1 PENDING</div>
                    </div>
                  </div>
                  {/* Middle DAG & Diff */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: '6px', flex: 1 }}>
                    <div style={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '4px', padding: '6px', fontSize: '8.5px' }}>
                      <div style={{ color: '#64748b', fontWeight: 600, marginBottom: '4px' }}>DAG PIPELINE</div>
                      <div style={{ color: '#34d399', marginBottom: '2px' }}>✓ 1. Requirement Spec</div>
                      <div style={{ color: '#60a5fa', marginBottom: '2px' }}>⟳ 2. Claude Generator</div>
                      <div style={{ color: '#fbbf24', marginBottom: '2px' }}>⚠ 3. Run Test Approval</div>
                      <div style={{ color: '#64748b' }}>○ 4. Deploy Artifact</div>
                    </div>
                    <div style={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '4px', padding: '6px', fontSize: '8.5px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                      <div>
                        <div style={{ color: '#64748b', fontWeight: 600, marginBottom: '2px' }}>DIFF & ARTIFACT</div>
                        <div style={{ color: '#34d399', fontFamily: 'monospace' }}>+ export function execute()</div>
                        <div style={{ color: '#f87171', fontFamily: 'monospace' }}>- // mock function</div>
                      </div>
                      <div style={{ backgroundColor: 'rgba(251, 191, 36, 0.15)', border: '1px solid rgba(251, 191, 36, 0.3)', padding: '3px 6px', borderRadius: '3px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: '#fbbf24', fontSize: '8px' }}>命令授权待批</span>
                        <span style={{ backgroundColor: '#fbbf24', color: '#000', padding: '1px 4px', borderRadius: '2px', fontSize: '8px', fontWeight: 600 }}>批准</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {current.id === 'proposal-3' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, minHeight: '190px' }}>
                  <div style={{ height: '22px', backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px', fontSize: '9px' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <span style={{ color: '#818cf8', fontWeight: 600 }}>Artifact Studio</span>
                      <span style={{ color: '#f1f5f9' }}>工作流</span>
                      <span style={{ color: '#64748b' }}>运行记录</span>
                      <span style={{ color: '#64748b' }}>产物库</span>
                    </div>
                    <span style={{ backgroundColor: '#4f46e5', color: '#fff', padding: '1px 5px', borderRadius: '2px', fontSize: '8px' }}>▶ 启动</span>
                  </div>
                  <div style={{ flex: 1, backgroundColor: '#020617', border: '1px dashed #334155', borderRadius: '4px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative', padding: '10px' }}>
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                      <div style={{ backgroundColor: '#1e293b', border: '1px solid #334155', padding: '6px', borderRadius: '4px', textAlign: 'center', fontSize: '8.5px' }}>
                        <div style={{ color: '#f8fafc', fontWeight: 600 }}>需求节点</div>
                        <div style={{ color: '#64748b', fontSize: '7.5px' }}>spec.md</div>
                      </div>
                      <span style={{ color: '#475569' }}>➔</span>
                      <div style={{ backgroundColor: '#1e1b4b', border: '1px solid #6366f1', padding: '6px', borderRadius: '4px', textAlign: 'center', fontSize: '8.5px' }}>
                        <div style={{ color: '#c7d2fe', fontWeight: 600 }}>Agent 执行</div>
                        <div style={{ color: '#818cf8', fontSize: '7.5px' }}>Claude Code</div>
                      </div>
                      <span style={{ color: '#475569' }}>➔</span>
                      <div style={{ backgroundColor: '#1e293b', border: '1px solid #334155', padding: '6px', borderRadius: '4px', textAlign: 'center', fontSize: '8.5px' }}>
                        <div style={{ color: '#f8fafc', fontWeight: 600 }}>产物封装</div>
                        <div style={{ color: '#64748b', fontSize: '7.5px' }}>dist.zip</div>
                      </div>
                    </div>
                    <div style={{ position: 'absolute', bottom: '6px', backgroundColor: 'rgba(30, 41, 59, 0.9)', border: '1px solid #475569', borderRadius: '999px', padding: '2px 10px', fontSize: '8px', color: '#cbd5e1' }}>
                      Dock: + 添加 | ⛶ 居中 | ⚙ 配置
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Proposal description and CTA */}
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              <div>
                <h3 style={{ margin: '0 0 6px 0', fontSize: '15px', fontWeight: 600, color: '#f8fafc' }}>
                  {current.title}
                </h3>
                <p style={{ margin: '0 0 14px 0', fontSize: '12px', color: '#94a3b8', lineHeight: 1.6 }}>
                  {current.description}
                </p>

                <div style={{ fontSize: '11px', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px', textTransform: 'uppercase' }}>
                  核心特性：
                </div>
                <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '12px', color: '#94a3b8', lineHeight: 1.8 }}>
                  {current.highlights.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              </div>

              <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid #1e293b' }}>
                <button
                  type="button"
                  onClick={() => {
                    if (onApplyProposal) onApplyProposal(current.id)
                    onClose()
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                    padding: '10px 16px',
                    borderRadius: '6px',
                    backgroundColor: '#4f46e5',
                    color: '#ffffff',
                    fontSize: '12px',
                    fontWeight: 600,
                    border: 'none',
                    cursor: 'pointer',
                    boxShadow: '0 4px 12px rgba(79, 70, 229, 0.4)',
                  }}
                >
                  <span>采用此方案重构系统视图</span>
                  <ArrowRight style={{ width: '14px', height: '14px' }} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 20px',
            backgroundColor: '#090d16',
            borderTop: '1px solid #1e293b',
          }}
        >
          <span style={{ fontSize: '11px', color: '#64748b' }}>
            提示：选定方案后，将根据此交互架构重构工作区
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '6px 12px',
              borderRadius: '4px',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              color: '#cbd5e1',
              fontSize: '11px',
              cursor: 'pointer',
            }}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
