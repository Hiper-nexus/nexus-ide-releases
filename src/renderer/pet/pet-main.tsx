import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PetApp } from './PetApp';
import './pet.css';

const root = document.getElementById('pet-root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <PetApp />
    </StrictMode>,
  );
}
