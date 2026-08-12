import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
/**
 * Vue Flow's stylesheet, global and deliberately not inside the composer's own
 * `<style scoped>`.
 *
 * Scoping rewrites every selector to match `[data-v-…]`, and Vue Flow builds its
 * pane, viewport, nodes and edges itself — none of which carry this component's
 * scope attribute. The rules therefore matched nothing, `.vue-flow`'s own
 * `width/height: 100%` never applied, and the canvas rendered as an unsized empty
 * box while the surrounding layout collapsed around it.
 */
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'

createApp(App).use(createPinia()).mount('#app')
