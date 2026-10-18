import { createRoot } from 'react-dom/client';
import App from './App';
import Projection from './Projection';
import { ClassroomController } from './lib/controller';
import './styles.css';
const root = createRoot(document.getElementById('root')!);
if (location.pathname === '/subtitles') root.render(<Projection/>);
else root.render(<App controller={new ClassroomController()}/>);
