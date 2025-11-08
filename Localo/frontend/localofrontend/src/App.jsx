import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix Leaflet default icon
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Configuration
const CONFIG = {
  apiUrl: 'http://localhost:3001/api',
  pollingInterval: 3000,
  heartbeatInterval: 30000,
  geocodeCacheTime: 5 * 60 * 1000, // 5 minutes
  locationUpdateThrottle: 2000, // 2 seconds
  maxRetries: 3
};

// Custom hooks
function useUserId() {
  const [userId, setUserId] = useState(null);

  useEffect(() => {
    let id = localStorage.getItem('localo-user-id');
    if (!id) {
      id = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('localo-user-id', id);
    }
    setUserId(id);
  }, []);

  return userId;
}

function useGeolocation(enabled) {
  const [location, setLocation] = useState(null);
  const [error, setError] = useState(null);
  const watchIdRef = useRef(null);

  useEffect(() => {
    if (!enabled || !navigator.geolocation) {
      if (!navigator.geolocation) {
        setError('Geolocation not supported');
      }
      return;
    }

    const options = {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 5000
    };

    const handleSuccess = (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      setLocation({ lat: latitude, lng: longitude, accuracy });
      setError(null);
    };

    const handleError = (err) => {
      setError(err.message);
    };

    navigator.geolocation.getCurrentPosition(handleSuccess, handleError, options);
    watchIdRef.current = navigator.geolocation.watchPosition(handleSuccess, handleError, options);

    return () => {
      if (watchIdRef.current) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, [enabled]);

  return { location, error };
}

// Geocoding cache
const geocodeCache = new Map();

async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  
  const cached = geocodeCache.get(key);
  if (cached && Date.now() - cached.timestamp < CONFIG.geocodeCacheTime) {
    return cached.address;
  }

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16`,
      { headers: { 'Accept-Language': 'en' } }
    );
    
    if (!response.ok) throw new Error('Geocoding failed');
    
    const data = await response.json();
    const address = data.display_name || 'Unknown location';
    
    geocodeCache.set(key, { address, timestamp: Date.now() });
    
    // Clear old cache entries
    if (geocodeCache.size > 100) {
      const oldestKey = geocodeCache.keys().next().value;
      geocodeCache.delete(oldestKey);
    }
    
    return address;
  } catch (err) {
    return 'Location unavailable';
  }
}

// API client with retry logic
async function apiRequest(endpoint, options = {}, retries = CONFIG.maxRetries) {
  try {
    const response = await fetch(`${CONFIG.apiUrl}${endpoint}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });

    if (!response.ok && retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return apiRequest(endpoint, options, retries - 1);
    }

    return response.ok ? await response.json() : null;
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return apiRequest(endpoint, options, retries - 1);
    }
    console.error('API request failed:', error);
    return null;
  }
}

// Memoized marker icon
const userIcon = L.divIcon({
  className: 'custom-marker',
  html: `<div style="width:32px;height:32px;background:#3b82f6;border:3px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.3);"></div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

const otherIcon = L.divIcon({
  className: 'custom-marker',
  html: `<div style="width:32px;height:32px;background:#ef4444;border:3px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.3);"></div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

// Map updater component
function MapUpdater({ center }) {
  const map = useMap();
  
  useEffect(() => {
    if (center) {
      map.setView(center, map.getZoom(), { animate: true, duration: 0.5 });
    }
  }, [center, map]);
  
  return null;
}

// User marker component (memoized)
const UserMarker = React.memo(({ position, isCurrentUser, name, address }) => (
  <Marker position={position} icon={isCurrentUser ? userIcon : otherIcon}>
    <Popup>
      <div className="text-center">
        <p className={`font-semibold ${isCurrentUser ? 'text-blue-600' : 'text-red-600'}`}>
          {name}
        </p>
        {address && <p className="text-xs text-gray-600 mt-1">{address}</p>}
      </div>
    </Popup>
  </Marker>
));

function App() {
  const [isTracking, setIsTracking] = useState(false);
  const [users, setUsers] = useState({});
  const [locationName, setLocationName] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [error, setError] = useState(null);

  const userId = useUserId();
  const { location, error: geoError } = useGeolocation(isTracking);
  
  const lastLocationUpdateRef = useRef(0);
  const pollingTimeoutRef = useRef(null);
  const heartbeatTimeoutRef = useRef(null);

  // Register user on mount
  useEffect(() => {
    if (!userId) return;

    apiRequest('/users/register', {
      method: 'POST',
      body: JSON.stringify({ userId })
    }).then(result => {
      if (result?.success) {
        setIsConnected(true);
      }
    });
  }, [userId]);

  // Update geolocation error
  useEffect(() => {
    if (geoError) {
      setError(geoError);
    }
  }, [geoError]);

  // Throttled location update
  useEffect(() => {
    if (!location || !isTracking || !userId) return;

    const now = Date.now();
    if (now - lastLocationUpdateRef.current < CONFIG.locationUpdateThrottle) {
      return;
    }

    lastLocationUpdateRef.current = now;

    (async () => {
      const address = await reverseGeocode(location.lat, location.lng);
      setLocationName(address);

      await apiRequest('/location/update', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          location,
          address,
          isTracking: true
        })
      });
    })();
  }, [location, isTracking, userId]);

  // Polling for active users
  const pollUsers = useCallback(async () => {
    if (!userId) return;

    const data = await apiRequest('/users/active');
    
    if (data?.users) {
      const usersMap = {};
      data.users.forEach(user => {
        if (user.userId !== userId) {
          usersMap[user.userId] = user;
        }
      });
      setUsers(usersMap);
      setLastUpdate(new Date());
    }

    pollingTimeoutRef.current = setTimeout(pollUsers, CONFIG.pollingInterval);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    
    pollUsers();
    
    return () => {
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current);
      }
    };
  }, [userId, pollUsers]);

  // Heartbeat
  const sendHeartbeat = useCallback(async () => {
    if (!userId || !isTracking) return;

    await apiRequest('/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ userId })
    });

    heartbeatTimeoutRef.current = setTimeout(sendHeartbeat, CONFIG.heartbeatInterval);
  }, [userId, isTracking]);

  useEffect(() => {
    if (!isTracking) return;
    
    sendHeartbeat();
    
    return () => {
      if (heartbeatTimeoutRef.current) {
        clearTimeout(heartbeatTimeoutRef.current);
      }
    };
  }, [isTracking, sendHeartbeat]);

  // Start tracking
  const startTracking = useCallback(() => {
    if (!navigator.geolocation) {
      setError('Geolocation not supported');
      return;
    }
    setError(null);
    setIsTracking(true);
  }, []);

  // Stop tracking
  const stopTracking = useCallback(async () => {
    setIsTracking(false);
    
    if (userId) {
      await apiRequest('/location/stop', {
        method: 'POST',
        body: JSON.stringify({ userId })
      });
    }
  }, [userId]);

  // Memoized map center
  const mapCenter = useMemo(() => 
    location ? [location.lat, location.lng] : [51.505, -0.09],
    [location]
  );

  // Memoized user markers
  const userMarkers = useMemo(() => 
    Object.entries(users).map(([id, data]) => 
      data.location ? (
        <UserMarker
          key={id}
          position={[data.location.lat, data.location.lng]}
          isCurrentUser={false}
          name={`User ${id.substring(0, 8)}`}
          address={data.address}
        />
      ) : null
    ).filter(Boolean),
    [users]
  );

  const secondsAgo = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <header className="bg-white shadow-md">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg flex items-center justify-center">
                <span className="text-white text-xl font-bold">L</span>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Localo</h1>
                <p className="text-xs text-gray-500">Optimized Polling</p>
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-600">
                {Object.keys(users).length} online
              </span>
              <div className="flex items-center space-x-2">
                <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
                {secondsAgo !== null && (
                  <span className="text-xs text-gray-500">{secondsAgo}s ago</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between space-y-4 md:space-y-0">
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-gray-900 mb-2">
                Real-time Location Tracking
              </h2>
              {locationName && (
                <p className="text-sm text-gray-600 mb-2">📍 {locationName}</p>
              )}
              {error && (
                <p className="text-sm text-red-600 mb-2">⚠️ {error}</p>
              )}
              <p className="text-sm text-gray-500">
                {isTracking
                  ? '🟢 Tracking active - Updates every 2s'
                  : '⚫ Tracking inactive'}
              </p>
            </div>
            <button
              onClick={isTracking ? stopTracking : startTracking}
              className={`px-6 py-3 rounded-lg font-semibold text-white transition-all ${
                isTracking
                  ? 'bg-red-500 hover:bg-red-600'
                  : 'bg-blue-500 hover:bg-blue-600'
              }`}
            >
              {isTracking ? 'Stop Tracking' : 'Start Tracking'}
            </button>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-lg overflow-hidden">
          <div className="h-[600px]">
            <MapContainer
              center={mapCenter}
              zoom={13}
              style={{ height: '100%', width: '100%' }}
              zoomControl={true}
            >
              <TileLayer
                attribution='&copy; OpenStreetMap'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <MapUpdater center={location ? [location.lat, location.lng] : null} />
              
              {location && (
                <UserMarker
                  position={[location.lat, location.lng]}
                  isCurrentUser={true}
                  name="You"
                  address={locationName}
                />
              )}

              {userMarkers}
            </MapContainer>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="font-semibold text-gray-700 mb-2">Optimized</h3>
            <p className="text-sm text-gray-600">
              Throttled updates, cached geocoding, and retry logic for optimal performance.
            </p>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="font-semibold text-gray-700 mb-2">Privacy</h3>
            <p className="text-sm text-gray-600">
              Location only shared while tracking. Stop anytime.
            </p>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="font-semibold text-gray-700 mb-2">Legend</h3>
            <div className="flex items-center space-x-2 text-sm">
              <div className="w-4 h-4 bg-blue-500 rounded-full" />
              <span className="text-gray-600">You</span>
              <div className="w-4 h-4 bg-red-500 rounded-full ml-4" />
              <span className="text-gray-600">Others</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;