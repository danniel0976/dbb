import React from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import AddCardModal from '../../src/components/AddCardModal.js'
import CardScannerPanel from '../../src/components/CardScannerPanel.js'
const root = createRoot(document.getElementById('root'))
window.renderModal = () => root.render(React.createElement(AddCardModal, { binders: [{ id: 'generic', name: 'Generic binder' }], onClose: () => root.render(null), onAdded() {} }))
window.renderPanel = count => {
  const rows = Array.from({length:count},(_,i)=>({shelfId:`generic-${i}`,cardName:`Generic card ${i}`,selected:true,quantity:1,finishes:['nonfoil'],finish:'nonfoil'}))
  const panel = React.createElement(CardScannerPanel, {onEvidence(){},onManual(){},shelf:rows}, React.createElement('section',{},'Generic chooser',React.createElement('div',{style:{height:200}},'Printing choices')))
  const shell = React.createElement('div', {style:{position:'fixed',inset:0,display:'flex',flexDirection:'column',padding:12}}, React.createElement('header',{style:{height:68,flexShrink:0}},'Scanner layout fixture'), React.createElement('div',{style:{flex:1,minHeight:0}},panel))
  root.render(createPortal(shell, document.body))
}
window.renderModal()
