'use client';
import { createContext, useContext } from 'react';
export const TzContext = createContext<string>('America/New_York');
export const useTz = () => useContext(TzContext);
